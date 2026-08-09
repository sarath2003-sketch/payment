const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

let pgPool = null;
let useSQLite = false;
let sqliteDb = null;
let sqliteInitialized = false;

// Create database directory if missing
const dbDir = path.join(__dirname, '..', 'database');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqliteDbPath = path.join(dbDir, 'payment_system.sqlite');

// Postgres Connection String
let connectionString = process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/amount_management_db';

if (connectionString && process.env.DOCKER_ENV !== 'true') {
  connectionString = connectionString.replace(/@db:/, '@localhost:');
}

const useSsl = !(connectionString.includes('localhost') || connectionString.includes('db:'));

try {
  pgPool = new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 1500
  });

  pgPool.on('error', (err) => {
    console.warn('[PostgreSQL Pool Warning]', err.message);
  });
} catch (err) {
  console.warn('[PostgreSQL Init Exception]', err.message);
}

// SQLite Driver & Fallback Logic
function initSQLiteFallback() {
  if (sqliteDb) return sqliteDb;
  console.warn('------------------------------------------------------------------');
  console.warn('[DB NOTICE] PostgreSQL connection unauthenticated or offline.');
  console.warn('[DB NOTICE] Seamlessly initializing local SQLite database fallback...');
  console.warn('------------------------------------------------------------------');

  const sqlite3 = require('sqlite3').verbose();
  sqliteDb = new sqlite3.Database(sqliteDbPath);

  // Initialize SQLite Schema
  if (!sqliteInitialized) {
    sqliteInitialized = true;
    sqliteDb.serialize(() => {
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          phone TEXT UNIQUE NOT NULL,
          upi_id TEXT,
          password_hash TEXT NOT NULL,
          balance REAL DEFAULT 0.00,
          status TEXT DEFAULT 'ACTIVE',
          activation_status TEXT DEFAULT 'PENDING',
          payment_status TEXT DEFAULT 'UNPAID',
          group_category TEXT DEFAULT 'General',
          is_duplicate INTEGER DEFAULT 0,
          duplicate_reason TEXT,
          duplicate_of_id INTEGER,
          duplicate_reviewed INTEGER DEFAULT 0,
          deleted_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Safe column migration for SQLite if table already existed
      const memberCols = ['upi_id TEXT', 'activation_status TEXT DEFAULT "PENDING"', 'payment_status TEXT DEFAULT "UNPAID"', 'group_category TEXT DEFAULT "General"', 'is_duplicate INTEGER DEFAULT 0', 'duplicate_reason TEXT', 'duplicate_of_id INTEGER', 'duplicate_reviewed INTEGER DEFAULT 0', 'deleted_at DATETIME'];
      memberCols.forEach(colDef => {
        const colName = colDef.split(' ')[0];
        sqliteDb.run(`ALTER TABLE members ADD COLUMN ${colDef}`, (err) => {
          // Ignore error if column already exists
        });
      });

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS admin_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          email TEXT,
          status TEXT DEFAULT 'ACTIVE',
          last_login DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS payment_proofs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          transaction_reference TEXT,
          payment_date TEXT NOT NULL,
          proof_file_path TEXT,
          proof_file_name TEXT,
          status TEXT DEFAULT 'PENDING',
          rejection_reason TEXT,
          verified_by INTEGER,
          verified_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS monthly_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          year INTEGER NOT NULL,
          month INTEGER NOT NULL,
          amount_due REAL NOT NULL DEFAULT 500.00,
          amount_paid REAL DEFAULT 0.00,
          status TEXT DEFAULT 'DUE' NOT NULL,
          due_date TEXT,
          payment_date TEXT,
          payment_proof_id INTEGER,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (member_id, year, month)
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS withdrawals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          month TEXT NOT NULL,
          withdrawal_date TEXT NOT NULL,
          amount REAL NOT NULL,
          reason TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS member_otp (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          otp_code TEXT NOT NULL,
          purpose TEXT DEFAULT 'PASSWORD_RESET',
          status TEXT DEFAULT 'PENDING',
          expires_at DATETIME NOT NULL,
          attempts INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_type TEXT NOT NULL,
          actor_id INTEGER NOT NULL,
          actor_name TEXT,
          action TEXT NOT NULL,
          entity_type TEXT,
          entity_id INTEGER,
          details TEXT,
          ip_address TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Seed initial admin user if missing
      sqliteDb.run(`
        INSERT OR IGNORE INTO admin_users (username, password_hash, email, status)
        VALUES ('admin', '$2b$10$YourHashedPasswordHere', 'admin@amount-management.com', 'ACTIVE');
      `);
    });
    console.log('[SQLite DB] All tables verified and ready.');
  }

  useSQLite = true;
  return sqliteDb;
}

// Execute SQLite Query
function execSQLiteQuery(sqlText, params = []) {
  const db = initSQLiteFallback();

  return new Promise((resolve, reject) => {
    let sql = sqlText;

    // Convert $1, $2, $3 to ?
    sql = sql.replace(/\$\d+/g, '?');

    // Convert TO_CHAR(payment_date, 'YYYY-MM') -> strftime('%Y-%m', payment_date)
    sql = sql.replace(/TO_CHAR\(([^,]+),\s*'YYYY-MM'\)/gi, "strftime('%Y-%m', $1)");

    // Convert FOR UPDATE / ON CONFLICT...
    sql = sql.replace(/FOR UPDATE/gi, '');
    sql = sql.replace(/ON CONFLICT\s*\([^)]*\)\s*DO NOTHING/gi, 'OR IGNORE');

    const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN)/i.test(sql);

    if (isSelect) {
      db.all(sql, params, (err, rows) => {
        if (err) {
          console.error('[SQLite Select Error]', err.message, 'SQL:', sql);
          return reject(err);
        }
        resolve({ rows: rows || [], rowCount: (rows || []).length });
      });
    } else {
      db.run(sql, params, function (err) {
        if (err) {
          console.error('[SQLite Exec Error]', err.message, 'SQL:', sql);
          return reject(err);
        }
        const lastID = this.lastID;
        const changes = this.changes;

        // If RETURNING clause is present, fetch returned row
        if (/RETURNING/i.test(sql)) {
          const tableMatch = sql.match(/INSERT\s+INTO\s+([a-zA-Z0-9_]+)|UPDATE\s+([a-zA-Z0-9_]+)/i);
          const tableName = tableMatch ? (tableMatch[1] || tableMatch[2]) : null;

          if (tableName && lastID) {
            db.get(`SELECT * FROM ${tableName} WHERE id = ?`, [lastID], (err2, row) => {
              if (!err2 && row) {
                return resolve({ rows: [row], rowCount: 1 });
              }
              resolve({ rows: [{ id: lastID }], rowCount: changes });
            });
            return;
          }
        }
        resolve({ rows: [], rowCount: changes, lastID });
      });
    }
  });
}

// Unified Query Function
async function query(text, params = []) {
  if (!useSQLite && pgPool) {
    try {
      return await pgPool.query(text, params);
    } catch (pgError) {
      if (
        pgError.code === 'ECONNREFUSED' ||
        pgError.message.includes('password authentication failed') ||
        pgError.message.includes('connect ECONNREFUSED') ||
        pgError.message.includes('does not exist')
      ) {
        useSQLite = true;
        return await execSQLiteQuery(text, params);
      }
      throw pgError;
    }
  } else {
    return await execSQLiteQuery(text, params);
  }
}

// Unified Connect Function for Transactions
async function connect() {
  if (!useSQLite && pgPool) {
    try {
      const client = await pgPool.connect();
      return client;
    } catch (pgError) {
      if (
        pgError.code === 'ECONNREFUSED' ||
        pgError.message.includes('password authentication failed') ||
        pgError.message.includes('connect ECONNREFUSED')
      ) {
        useSQLite = true;
      } else {
        throw pgError;
      }
    }
  }

  // Return a mock client wrapping SQLite transaction queries
  initSQLiteFallback();
  return {
    query: async (text, params) => {
      const trimmed = (text || '').trim().toUpperCase();
      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      return await execSQLiteQuery(text, params);
    },
    release: () => {}
  };
}

module.exports = {
  query,
  connect,
  on: (event, handler) => {
    if (pgPool) pgPool.on(event, handler);
  }
};
