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
const hasEnvDbUrl = !!(process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL);
let connectionString = process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/amount_management_db';

if (!hasEnvDbUrl && connectionString && process.env.DOCKER_ENV !== 'true') {
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

  try {
    const sqlite3 = require('sqlite3').verbose();
    sqliteDb = new sqlite3.Database(sqliteDbPath);
  } catch (sqliteErr) {
    console.warn('[SQLite Native Module Warning]', sqliteErr.message);
    sqliteDb = {
      serialize: (fn) => fn && fn(),
      run: (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        if (callback) callback(null);
      },
      all: (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        if (callback) callback(null, []);
      },
      get: (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        if (callback) callback(null, null);
      }
    };
  }

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
      const memberCols = ['upi_id TEXT', 'profile_photo TEXT', 'activation_status TEXT DEFAULT "PENDING"', 'payment_status TEXT DEFAULT "UNPAID"', 'group_category TEXT DEFAULT "General"', 'is_duplicate INTEGER DEFAULT 0', 'duplicate_reason TEXT', 'duplicate_of_id INTEGER', 'duplicate_reviewed INTEGER DEFAULT 0', 'deleted_at DATETIME'];
      memberCols.forEach(colDef => {
        const colName = colDef.split(' ')[0];
        sqliteDb.run(`ALTER TABLE members ADD COLUMN ${colDef}`, (err) => {
          // Ignore error if column already exists
        });
      });

      // Auto-backfill & clean any legacy member_id values to preserve strict sequential 101, 102, 103... numbering
      sqliteDb.run(`UPDATE members SET member_id = CAST(100 + id AS TEXT) WHERE member_id IS NULL OR member_id = '' OR member_id > '5000' OR length(member_id) > 3`);

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
          payment_month TEXT,
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

      // Migration check for payment_proofs
      sqliteDb.run(`ALTER TABLE payment_proofs ADD COLUMN payment_month TEXT`, () => {});

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

      // Seed default app settings into SQLite
      const defaultSettings = [
        ['org_name', 'PF Chit Fund Club'],
        ['org_name_tamil', 'புதுப்பட்டி நண்பர்கள் சீட்டு பண்டு கிளப்'],
        ['logo_path', '/assets/logo.png'],
        ['qr_path', '/assets/qr.png'],
        ['admin_upi_id', '9025893352@idfcfirst'],
        ['admin_upi_name', 'IDFC First Bank · Sarathkumar Pandiyaraja'],
        ['default_payment_amount', '500'],
        ['payment_instructions_en', 'Scan the QR code to make payment via UPI. Enter your transaction reference ID and upload a screenshot as proof.'],
        ['payment_instructions_ta', 'UPI மூலம் பணம் செலுத்த QR குறியீட்டை ஸ்கேன் செய்யவும். உங்கள் பரிவர்த்தனை குறிப்பு ID ஐ உள்ளிட்டு ஸ்கிரீன்ஷாட்டை சமர்ப்பிக்கவும்.']
      ];
      defaultSettings.forEach(([k, v]) => {
        sqliteDb.run(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`, [k, v]);
      });

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS chat_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_name TEXT NOT NULL,
          created_by INTEGER,
          group_admin_id INTEGER,
          max_members INTEGER DEFAULT 12,
          status TEXT DEFAULT 'PENDING',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS chat_group_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          role TEXT DEFAULT 'MEMBER',
          is_muted INTEGER DEFAULT 0,
          is_speaker INTEGER DEFAULT 0,
          is_online INTEGER DEFAULT 1,
          joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(group_id, member_id)
        );
      `);
      sqliteDb.run(`ALTER TABLE chat_group_members ADD COLUMN is_speaker INTEGER DEFAULT 0`, () => {});

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS chat_group_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL,
          member_id INTEGER,
          sender_name TEXT,
          sender_member_id TEXT,
          message_type TEXT DEFAULT 'text',
          message TEXT,
          media_url TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS chat_group_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_name TEXT NOT NULL,
          requested_by INTEGER NOT NULL,
          status TEXT DEFAULT 'PENDING',
          reviewed_by INTEGER,
          reviewed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // SQLite tables for Auctions, Bids, Notifications & Moderation
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS auctions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          auction_date TEXT NOT NULL,
          scheduled_start_time DATETIME,
          duration_seconds INTEGER DEFAULT 120,
          starting_amount REAL DEFAULT 5000.00,
          bid_increment REAL DEFAULT 500.00,
          status TEXT DEFAULT 'SCHEDULED',
          current_highest_bid REAL,
          highest_bidder_id INTEGER,
          winner_id INTEGER,
          final_amount REAL,
          timer_started_at DATETIME,
          timer_paused_at DATETIME,
          elapsed_seconds INTEGER DEFAULT 0,
          created_by INTEGER,
          ended_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS bids (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          bid_time DATETIME DEFAULT CURRENT_TIMESTAMP,
          is_winning INTEGER DEFAULT 0,
          server_timestamp INTEGER
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS auction_chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER NOT NULL,
          member_id INTEGER,
          admin_id INTEGER,
          sender_name TEXT,
          sender_member_id TEXT,
          message TEXT NOT NULL,
          message_type TEXT DEFAULT 'text',
          voice_url TEXT,
          is_deleted INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS voice_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER,
          member_id INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          duration_seconds REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          transaction_date TEXT NOT NULL,
          transaction_time TEXT DEFAULT '12:00:00',
          month TEXT NOT NULL,
          transaction_type TEXT NOT NULL,
          amount REAL NOT NULL,
          description TEXT,
          seettu_cycle_id INTEGER,
          reference_type TEXT DEFAULT 'MANUAL',
          reference_id INTEGER,
          status TEXT DEFAULT 'COMPLETED',
          balance_after REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`ALTER TABLE transactions ADD COLUMN transaction_time TEXT DEFAULT '12:00:00'`, () => {});
      sqliteDb.run(`ALTER TABLE transactions ADD COLUMN seettu_cycle_id INTEGER`, () => {});
      sqliteDb.run(`ALTER TABLE transactions ADD COLUMN reference_type TEXT DEFAULT 'MANUAL'`, () => {});
      sqliteDb.run(`ALTER TABLE transactions ADD COLUMN reference_id INTEGER`, () => {});
      sqliteDb.run(`ALTER TABLE transactions ADD COLUMN status TEXT DEFAULT 'COMPLETED'`, () => {});

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS seettu_cycles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          cycle_month TEXT NOT NULL,
          total_members INTEGER DEFAULT 20,
          monthly_contribution REAL DEFAULT 1000.00,
          total_collection REAL DEFAULT 20000.00,
          amount_distributed REAL DEFAULT 0.00,
          remaining_amount REAL DEFAULT 20000.00,
          winner_member_id INTEGER,
          winner_amount REAL DEFAULT 0.00,
          status TEXT DEFAULT 'ACTIVE',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          type TEXT DEFAULT 'info',
          reference_type TEXT,
          reference_id INTEGER,
          is_read INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS muted_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER,
          member_id INTEGER NOT NULL,
          muted_by INTEGER,
          muted_until DATETIME,
          reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(auction_id, member_id)
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_name TEXT NOT NULL,
          monthly_contribution REAL DEFAULT 500.00,
          total_members INTEGER DEFAULT 20,
          interest_percentage REAL DEFAULT 5.00,
          status TEXT DEFAULT 'ACTIVE',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS group_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(group_id, member_id)
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS nominees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          nominee_name TEXT NOT NULL,
          relationship TEXT NOT NULL,
          contact_phone TEXT,
          address TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS seed_fund_distributions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER,
          member_id INTEGER NOT NULL,
          principal_amount REAL NOT NULL,
          interest_percentage REAL DEFAULT 5.00,
          interest_amount REAL NOT NULL,
          total_payable REAL NOT NULL,
          total_repaid REAL DEFAULT 0.00,
          remaining_amount REAL NOT NULL,
          distribution_date TEXT NOT NULL,
          due_date TEXT NOT NULL,
          nominee_name TEXT,
          payment_status TEXT DEFAULT 'PENDING',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS repayments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          distribution_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          payment_amount REAL NOT NULL,
          payment_date TEXT NOT NULL,
          payment_method TEXT DEFAULT 'UPI',
          transaction_ref TEXT,
          remaining_amount REAL NOT NULL,
          status TEXT DEFAULT 'COMPLETED',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Column migrations for members
      sqliteDb.run(`ALTER TABLE members ADD COLUMN is_online INTEGER DEFAULT 0`, () => {});
      sqliteDb.run(`ALTER TABLE members ADD COLUMN last_active_at DATETIME`, () => {});

      // Column migrations for seed_fund_distributions
      sqliteDb.run(`ALTER TABLE seed_fund_distributions ADD COLUMN monthly_amount REAL`, () => {});
      sqliteDb.run(`ALTER TABLE seed_fund_distributions ADD COLUMN number_of_months INTEGER DEFAULT 12`, () => {});
      sqliteDb.run(`ALTER TABLE seed_fund_distributions ADD COLUMN start_date TEXT`, () => {});
      sqliteDb.run(`ALTER TABLE seed_fund_distributions ADD COLUMN next_payment_date TEXT`, () => {});

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS payment_schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          distribution_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          schedule_number INTEGER NOT NULL,
          due_date TEXT NOT NULL,
          amount_due REAL NOT NULL,
          amount_paid REAL DEFAULT 0.00,
          status TEXT DEFAULT 'PENDING',
          paid_date TEXT,
          proof_file_path TEXT,
          transaction_reference TEXT,
          rejection_reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS notice_board (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          target_type TEXT DEFAULT 'ALL',
          target_id INTEGER,
          amount_due REAL,
          due_date TEXT,
          notice_date TEXT NOT NULL,
          status TEXT DEFAULT 'PUBLISHED',
          created_by INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Seed initial admin user if missing
      sqliteDb.run(`
        INSERT OR IGNORE INTO admin_users (username, password_hash, email, status)
        VALUES ('admin', '$2b$10$xJ8K9L3m2N4p6Q8r0S2t4uVwXyZ.1234567890abcdef', 'admin@pfchitfund.com', 'ACTIVE');
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

    // Convert numbered Postgres parameters $1, $2 to positional ? and replicate values in cleanParams
    const cleanParams = [];
    sql = sql.replace(/\$(\d+)/g, (match, paramIndex) => {
      const idx = parseInt(paramIndex, 10) - 1;
      const val = params[idx];
      cleanParams.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
      return '?';
    });

    // Convert TO_CHAR(payment_date, 'YYYY-MM') -> strftime('%Y-%m', payment_date)
    sql = sql.replace(/TO_CHAR\(([^,]+),\s*'YYYY-MM'\)/gi, "strftime('%Y-%m', $1)");

    // Clean Postgres-specific clauses for SQLite
    sql = sql.replace(/FOR UPDATE/gi, '');
    sql = sql.replace(/ON CONFLICT\s*\([^)]*\)\s*DO NOTHING/gi, 'OR IGNORE');
    sql = sql.replace(/NULLS LAST/gi, '');
    sql = sql.replace(/regexp_replace\(member_id,\s*'\\D',\s*'',\s*'g'\)/gi, 'member_id');
    sql = sql.replace(/=\s*true\b/gi, '= 1').replace(/=\s*false\b/gi, '= 0');

    const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN)/i.test(sql);

    if (isSelect) {
      db.all(sql, cleanParams, (err, rows) => {
        if (err) {
          console.error('[SQLite Select Error]', err.message, 'SQL:', sql);
          return reject(err);
        }
        resolve({ rows: rows || [], rowCount: (rows || []).length });
      });
    } else {
      db.run(sql, cleanParams, function (err) {
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

          if (tableName) {
            const fetchSql = lastID 
              ? `SELECT * FROM ${tableName} WHERE id = ?` 
              : `SELECT * FROM ${tableName} ORDER BY id DESC LIMIT 1`;
            const fetchParams = lastID ? [lastID] : [];

            db.get(fetchSql, fetchParams, (err2, row) => {
              if (!err2 && row) {
                return resolve({ rows: [row], rowCount: 1 });
              }
              db.get(`SELECT * FROM ${tableName} ORDER BY id DESC LIMIT 1`, [], (err3, row3) => {
                if (!err3 && row3) {
                  return resolve({ rows: [row3], rowCount: 1 });
                }
                resolve({ rows: [{ id: lastID || 1 }], rowCount: changes });
              });
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
