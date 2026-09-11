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

// Check if 100% Localhost Storage / SQLite mode is enabled (DATABASE_URL takes priority if configured)
const isLocalStorageMode = !process.env.DATABASE_URL && 
                           (process.env.USE_LOCAL_STORAGE === 'true' || 
                            process.env.USE_SQLITE === 'true' || 
                            process.env.DB_CLIENT === 'sqlite' || 
                            !process.env.DATABASE_URL);

if (isLocalStorageMode) {
  useSQLite = true;
  console.log('------------------------------------------------------------------');
  console.log('[LOCAL STORAGE] 100% Localhost Storage Mode Active');
  console.log(`[LOCAL STORAGE] Database: ${sqliteDbPath}`);
  console.log(`[LOCAL STORAGE] Uploads : ${path.resolve(process.env.UPLOAD_DIR || './uploads')}`);
  console.log('------------------------------------------------------------------');
  initSQLiteFallback();
} else {
  // Postgres Connection String (when local storage mode is not forced)
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
}

// ============================================================
// Pure-JavaScript File-Backed JSON Store Engine
// Activates seamlessly if sqlite3 native module cannot be loaded
// ============================================================
function createJsonStore(storeFilePath) {
  let tables = {};

  function saveToDisk() {
    try {
      const dir = path.dirname(storeFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(storeFilePath, JSON.stringify(tables, null, 2), 'utf8');
    } catch (e) {
      console.warn('[JSON Store Save Warning]', e.message);
    }
  }

  function loadFromDisk() {
    if (fs.existsSync(storeFilePath)) {
      try {
        tables = JSON.parse(fs.readFileSync(storeFilePath, 'utf8'));
        return;
      } catch (e) {
        console.warn('[JSON Store Load Warning]', e.message);
      }
    }
    const initPath = path.join(path.dirname(storeFilePath), 'initial_data.json');
    if (fs.existsSync(initPath)) {
      try {
        tables = JSON.parse(fs.readFileSync(initPath, 'utf8'));
        saveToDisk();
        console.log('[JSON Store] Seeded tables from initial_data.json successfully.');
      } catch (e) {
        console.warn('[JSON Store Initial Seed Error]', e.message);
      }
    }
  }

  loadFromDisk();

  function getTable(name) {
    const key = (name || '').trim().toLowerCase();
    for (const k of Object.keys(tables)) {
      if (k.toLowerCase() === key) return tables[k];
    }
    tables[key] = [];
    return tables[key];
  }

  function setTable(name, arr) {
    const key = (name || '').trim().toLowerCase();
    for (const k of Object.keys(tables)) {
      if (k.toLowerCase() === key) {
        tables[k] = arr;
        saveToDisk();
        return;
      }
    }
    tables[key] = arr;
    saveToDisk();
  }

  const db = {
    serialize: (fn) => fn && fn(),

    run: function (sql, params, cb) {
      const callback = typeof params === 'function' ? params : cb;
      const cleanParams = Array.isArray(params) ? [...params] : [];
      let lastID = null;
      let changes = 0;

      const trimmed = (sql || '').trim();

      // Transactions / schema / PRAGMA
      if (/^(BEGIN|COMMIT|ROLLBACK|PRAGMA)/i.test(trimmed)) {
        if (callback) callback.call({ lastID: 0, changes: 0 }, null);
        return;
      }

      // CREATE TABLE
      if (/^CREATE\s+TABLE/i.test(trimmed)) {
        const m = trimmed.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i);
        if (m) getTable(m[1]);
        saveToDisk();
        if (callback) callback.call({ lastID: 0, changes: 0 }, null);
        return;
      }

      // ALTER TABLE
      if (/^ALTER\s+TABLE/i.test(trimmed)) {
        if (callback) callback.call({ lastID: 0, changes: 0 }, null);
        return;
      }

      // INSERT INTO
      if (/^INSERT/i.test(trimmed)) {
        const m = trimmed.match(/INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (m) {
          const tableName = m[1];
          const cols = m[2].split(',').map(c => c.trim());
          const valPlaceholders = m[3].split(',').map(v => v.trim());
          const rows = getTable(tableName);

          const newRow = {};
          let maxId = 0;
          rows.forEach(r => { if (r.id && Number(r.id) > maxId) maxId = Number(r.id); });
          newRow.id = maxId + 1;
          newRow.created_at = new Date().toISOString().replace('T', ' ').substring(0, 19);
          newRow.updated_at = newRow.created_at;

          let pIdx = 0;
          cols.forEach((col, i) => {
            const ph = valPlaceholders[i] || '?';
            if (ph === '?') {
              newRow[col] = cleanParams[pIdx++];
            } else if (/^'.*'$/.test(ph)) {
              newRow[col] = ph.slice(1, -1);
            } else if (!isNaN(Number(ph))) {
              newRow[col] = Number(ph);
            } else {
              newRow[col] = ph;
            }
          });

          // Handle conflict / duplicate ignore
          let isDup = false;
          if (/INSERT\s+OR\s+IGNORE/i.test(trimmed)) {
            if (newRow.key && rows.some(r => r.key === newRow.key)) isDup = true;
            if (newRow.username && rows.some(r => r.username === newRow.username)) isDup = true;
            if (newRow.member_id && rows.some(r => r.member_id === newRow.member_id)) isDup = true;
          }

          if (!isDup) {
            rows.push(newRow);
            lastID = newRow.id;
            changes = 1;
            saveToDisk();
          }
        }
        if (callback) callback.call({ lastID: lastID || 1, changes }, null);
        return;
      }

      // UPDATE
      if (/^UPDATE/i.test(trimmed)) {
        const m = trimmed.match(/UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.*?)(?:\s+WHERE\s+(.*))?$/i);
        if (m) {
          const tableName = m[1];
          const setClause = m[2];
          const whereClause = m[3] || '';
          const rows = getTable(tableName);

          const setParts = setClause.split(',').map(s => s.trim());
          let pIdx = 0;
          const updates = {};
          setParts.forEach(sp => {
            const eq = sp.split('=').map(x => x.trim());
            const col = eq[0];
            const valExpr = eq[1];
            if (valExpr === '?') {
              updates[col] = cleanParams[pIdx++];
            } else if (/CURRENT_TIMESTAMP/i.test(valExpr)) {
              updates[col] = new Date().toISOString().replace('T', ' ').substring(0, 19);
            } else if (/^'.*'$/.test(valExpr)) {
              updates[col] = valExpr.slice(1, -1);
            } else if (!isNaN(Number(valExpr))) {
              updates[col] = Number(valExpr);
            }
          });

          rows.forEach(r => {
            let match = true;
            if (whereClause) {
              if (/id\s*=\s*\?/i.test(whereClause)) {
                match = (r.id === cleanParams[pIdx]);
              } else if (/key\s*=\s*\?/i.test(whereClause)) {
                match = (r.key === cleanParams[pIdx]);
              } else if (/key\s*=\s*([a-zA-Z0-9_']+)/i.test(whereClause)) {
                const keyVal = whereClause.match(/key\s*=\s*([a-zA-Z0-9_']+)/i)[1].replace(/'/g, '');
                match = (r.key === keyVal);
              } else if (/username\s*=\s*\?/i.test(whereClause)) {
                match = (r.username === cleanParams[pIdx]);
              }
            }
            if (match) {
              Object.assign(r, updates, { updated_at: new Date().toISOString().replace('T', ' ').substring(0, 19) });
              changes++;
            }
          });
          saveToDisk();
        }
        if (callback) callback.call({ lastID: null, changes }, null);
        return;
      }

      // DELETE
      if (/^DELETE/i.test(trimmed)) {
        const m = trimmed.match(/DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.*))?$/i);
        if (m) {
          const tableName = m[1];
          const whereClause = m[2] || '';
          let rows = getTable(tableName);
          const initialLen = rows.length;
          if (!whereClause) {
            rows = [];
          } else if (/id\s*=\s*\?/i.test(whereClause)) {
            const targetId = cleanParams[0];
            rows = rows.filter(r => r.id !== targetId);
          }
          setTable(tableName, rows);
          changes = initialLen - rows.length;
        }
        if (callback) callback.call({ lastID: null, changes }, null);
        return;
      }

      if (callback) callback.call({ lastID: 1, changes: 0 }, null);
    },

    all: function (sql, params, cb) {
      const callback = typeof params === 'function' ? params : cb;
      const cleanParams = Array.isArray(params) ? [...params] : [];
      const trimmed = (sql || '').trim();

      // SELECT COUNT(*)
      if (/SELECT\s+count\(\*\)(?:\s+as\s+([a-zA-Z0-9_]+))?\s+FROM\s+([a-zA-Z0-9_]+)/i.test(trimmed)) {
        const m = trimmed.match(/SELECT\s+count\(\*\)(?:\s+as\s+([a-zA-Z0-9_]+))?\s+FROM\s+([a-zA-Z0-9_]+)/i);
        const alias = m[1] || 'cnt';
        const tableName = m[2];
        const rows = getTable(tableName);
        const res = {};
        res[alias] = rows.length;
        if (callback) callback(null, [res]);
        return;
      }

      // Standard SELECT
      const fromMatch = trimmed.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (!fromMatch) {
        if (callback) callback(null, [{ '1': 1 }]);
        return;
      }

      const tableName = fromMatch[1];
      let rows = [...getTable(tableName)];

      // WHERE filters
      if (/WHERE/i.test(trimmed)) {
        const whereIdx = trimmed.toUpperCase().indexOf('WHERE');
        const afterWhere = trimmed.substring(whereIdx + 5);

        // Member auth lookup: WHERE LOWER(member_id) = LOWER(?) OR LOWER(email) = LOWER(?) OR (phone = ? AND ? != '')
        if (/member_id/i.test(afterWhere) && /phone/i.test(afterWhere)) {
          const inputVal = (cleanParams[0] || '').toString().trim().toLowerCase();
          const cleanPhone = (cleanParams[cleanParams.length - 1] || inputVal).toString().replace(/\D/g, '').slice(-10);

          rows = rows.filter(r => {
            const mId = (r.member_id || '').toString().toLowerCase();
            const em = (r.email || '').toString().toLowerCase();
            const ph = (r.phone || '').toString().replace(/\D/g, '').slice(-10);
            return (mId && mId === inputVal) || (em && em === inputVal) || (ph && ph === cleanPhone);
          });
        }
        // Phone check: WHERE phone = ?
        else if (/phone\s*=\s*\?/i.test(afterWhere)) {
          const phTarget = (cleanParams[0] || '').toString().replace(/\D/g, '').slice(-10);
          rows = rows.filter(r => {
            const ph = (r.phone || '').toString().replace(/\D/g, '').slice(-10);
            return ph === phTarget;
          });
        }
        // ID check: WHERE id = ?
        else if (/id\s*=\s*\?/i.test(afterWhere)) {
          const idTarget = Number(cleanParams[0]);
          rows = rows.filter(r => r.id === idTarget);
        }
        // Key check for app_settings: WHERE key IN (...)
        else if (/key\s+IN\s*\(([^)]+)\)/i.test(afterWhere)) {
          const inKeys = afterWhere.match(/key\s+IN\s*\(([^)]+)\)/i)[1]
            .split(',').map(k => k.trim().replace(/'/g, ''));
          rows = rows.filter(r => inKeys.includes(r.key));
        }
        // Single key check: WHERE key = ?
        else if (/key\s*=\s*\?/i.test(afterWhere)) {
          const targetKey = cleanParams[0];
          rows = rows.filter(r => r.key === targetKey);
        }
        // Username check: WHERE username = ?
        else if (/username\s*=\s*\?/i.test(afterWhere)) {
          const targetUser = (cleanParams[0] || '').toString().toLowerCase();
          rows = rows.filter(r => (r.username || '').toString().toLowerCase() === targetUser);
        }
      }

      // Filter out deleted if deleted_at IS NULL is specified
      if (/deleted_at\s+IS\s+NULL/i.test(trimmed)) {
        rows = rows.filter(r => !r.deleted_at);
      }

      // Order by
      if (/ORDER\s+BY\s+([a-zA-Z0-9_]+)(?:\s+(ASC|DESC))?/i.test(trimmed)) {
        const om = trimmed.match(/ORDER\s+BY\s+([a-zA-Z0-9_]+)(?:\s+(ASC|DESC))?/i);
        const col = om[1];
        const isDesc = (om[2] || 'ASC').toUpperCase() === 'DESC';
        rows.sort((a, b) => {
          if (a[col] < b[col]) return isDesc ? 1 : -1;
          if (a[col] > b[col]) return isDesc ? -1 : 1;
          return 0;
        });
      }

      // Limit
      if (/LIMIT\s+(\d+)/i.test(trimmed)) {
        const lim = parseInt(trimmed.match(/LIMIT\s+(\d+)/i)[1], 10);
        rows = rows.slice(0, lim);
      }

      if (callback) callback(null, rows);
    },

    get: function (sql, params, cb) {
      db.all(sql, params, (err, rows) => {
        if (err) return cb ? cb(err) : null;
        if (cb) cb(null, (rows && rows.length > 0) ? rows[0] : null);
      });
    }
  };

  return db;
}

// Auto-seed function when tables are empty or missing members
function seedInitialDataIfEmpty(db) {
  const initPath = path.join(__dirname, '..', 'database', 'initial_data.json');
  if (!fs.existsSync(initPath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(initPath, 'utf8'));
    if (data.members && data.members.length > 0) {
      console.log('[DB Auto-Seed] Ensuring initial members are seeded into database...');
      data.members.forEach(m => {
        db.run(
          `INSERT OR IGNORE INTO members (id, member_id, name, email, phone, password_hash, balance, status, activation_status, payment_status, group_category, upi_id, profile_photo, is_duplicate, duplicate_reviewed, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
          [m.id, m.member_id, m.name, m.email, m.phone, m.password_hash, m.balance || 0, m.status || 'ACTIVE', m.activation_status || 'ACTIVE', m.payment_status || 'UNPAID', m.group_category || 'General', m.upi_id || null, m.profile_photo || null, m.created_at || '2026-09-11 10:00:00', m.updated_at || '2026-09-11 10:00:00']
        );
      });
    }
    if (data.app_settings && data.app_settings.length > 0) {
      data.app_settings.forEach(s => {
        db.run(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`, [s.key, s.value]);
      });
    }
    if (data.admin_users && data.admin_users.length > 0) {
      data.admin_users.forEach(a => {
        db.run(`INSERT OR IGNORE INTO admin_users (username, password_hash, email, status) VALUES (?, ?, ?, ?)`, [a.username, a.password_hash, a.email, a.status]);
      });
    }
    if (data.monthly_payments && data.monthly_payments.length > 0) {
      data.monthly_payments.forEach(p => {
        db.run(
          `INSERT OR IGNORE INTO monthly_payments (id, member_id, year, month, amount_due, amount_paid, status, due_date) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.id, p.member_id, p.year, p.month, p.amount_due, p.amount_paid, p.status, p.due_date]
        );
      });
    }
  } catch (e) {
    console.warn('[DB Auto-Seed Error]', e.message);
  }
}

// Persist active members and settings back to initial_data.json file
async function syncDatabaseToJson() {
  try {
    const initPath = path.join(__dirname, '..', 'database', 'initial_data.json');
    let currentData = {};
    if (fs.existsSync(initPath)) {
      try {
        currentData = JSON.parse(fs.readFileSync(initPath, 'utf8'));
      } catch(e) {}
    }
    
    // Fetch all active members
    const membersRes = await query(`
      SELECT id, member_id, name, email, phone, password_hash, balance, status, 
             activation_status, payment_status, group_category, upi_id, profile_photo,
             is_duplicate, duplicate_reason, duplicate_of_id, duplicate_reviewed,
             deleted_at, created_at, updated_at, is_online, last_active_at
      FROM members 
      WHERE deleted_at IS NULL
      ORDER BY id ASC
    `);

    // Fetch app_settings
    const settingsRes = await query(`SELECT key, value, updated_at FROM app_settings`);

    // Fetch monthly_payments
    const paymentsRes = await query(`SELECT * FROM monthly_payments WHERE member_id IN (SELECT id FROM members WHERE deleted_at IS NULL)`);

    if (membersRes.rows && membersRes.rows.length > 0) {
      currentData.members = membersRes.rows;
    }
    if (settingsRes.rows && settingsRes.rows.length > 0) {
      currentData.app_settings = settingsRes.rows;
    }
    if (paymentsRes.rows && paymentsRes.rows.length > 0) {
      currentData.monthly_payments = paymentsRes.rows;
    }

    fs.writeFileSync(initPath, JSON.stringify(currentData, null, 2), 'utf8');
    console.log(`[DB Auto-Sync] Persisted ${currentData.members.length} members to initial_data.json`);
    return { success: true, count: currentData.members.length };
  } catch (err) {
    console.warn('[DB Auto-Sync Warning]', err.message);
    return { success: false, error: err.message };
  }
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
    console.warn('[DB NOTICE] Switching to pure-JavaScript persistent JSON Store engine.');
    sqliteDb = createJsonStore(path.join(dbDir, 'payment_system_store.json'));
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

      // Auto-backfill missing member_id only if null or empty
      sqliteDb.run(`UPDATE members SET member_id = CAST(100 + id AS TEXT) WHERE member_id IS NULL OR TRIM(member_id) = ''`);

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
        ['admin_upi_id', 'sarath9025@cnrb'],
        ['admin_upi_name', 'Canara Bank · Sarathkumar'],
        ['default_payment_amount', '500'],
        ['monthly_due_day', '10'],
        ['auto_approve_payment', '1'],
        ['auto_verify_amount', '500'],
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
      sqliteDb.run(`ALTER TABLE chat_groups ADD COLUMN ludo_active INTEGER DEFAULT 0`, () => {});
      sqliteDb.run(`ALTER TABLE chat_groups ADD COLUMN ludo_state TEXT DEFAULT ''`, () => {});
      sqliteDb.run(`CREATE INDEX IF NOT EXISTS idx_chat_group_messages_gid ON chat_group_messages(group_id, created_at)`, () => {});

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

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS loan_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL,
          requested_amount REAL NOT NULL,
          nominee_name TEXT NOT NULL,
          nominee_phone TEXT,
          nominee_relation TEXT,
          purpose TEXT,
          status TEXT DEFAULT 'PENDING',
          admin_notes TEXT,
          reviewed_by INTEGER,
          reviewed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          category TEXT DEFAULT 'General',
          amount REAL NOT NULL,
          expense_date TEXT NOT NULL,
          expense_month TEXT NOT NULL,
          remarks TEXT,
          created_by INTEGER,
          created_by_name TEXT,
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
    seedInitialDataIfEmpty(sqliteDb);
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

    // Convert date formatting and PostgreSQL casts for SQLite.
    sql = sql.replace(/TO_CHAR\(([^,]+),\s*'YYYY-MM'\)/gi, "strftime('%Y-%m', $1)");
    sql = sql.replace(/([\w.]+)::text\b/gi, 'CAST($1 AS TEXT)');

    // Clean Postgres-specific clauses for SQLite
    sql = sql.replace(/FOR UPDATE/gi, '');
    if (/ON CONFLICT(?:\s*\([^)]*\))?\s*DO NOTHING/i.test(sql)) {
      sql = sql.replace(/INSERT\s+INTO/i, 'INSERT OR IGNORE INTO');
      sql = sql.replace(/ON CONFLICT(?:\s*\([^)]*\))?\s*DO NOTHING/gi, '');
    }
    sql = sql.replace(/NULLS LAST/gi, '');
    sql = sql.replace(/regexp_replace\(member_id,\s*'\\D',\s*'',\s*'g'\)/gi, 'CAST(member_id AS INTEGER)');
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
      let runSql = sql;
      if (/RETURNING/i.test(runSql)) {
        runSql = runSql.replace(/\s+RETURNING\s+[\s\S]*$/i, '');
      }

      db.run(runSql, cleanParams, function (err) {
        if (err) {
          console.error('[SQLite Exec Error]', err.message, 'SQL:', sql);
          return reject(err);
        }
        const lastID = this ? this.lastID : null;
        const changes = this ? this.changes : 0;

        // If RETURNING clause is present, fetch returned row
        if (/RETURNING/i.test(sql)) {
          const tableMatch = sql.match(/INSERT\s+INTO\s+([a-zA-Z0-9_]+)|UPDATE\s+([a-zA-Z0-9_]+)/i);
          const tableName = tableMatch ? (tableMatch[1] || tableMatch[2]) : null;

          if (tableName) {
            let targetId = lastID;
            if (!targetId && /UPDATE/i.test(sql)) {
              // Check if query has WHERE id = ?
              if (/WHERE\s+id\s*=\s*\?/i.test(sql) && cleanParams.length > 0) {
                targetId = cleanParams[cleanParams.length - 1];
              }
            }

            const fetchSql = targetId 
              ? `SELECT * FROM ${tableName} WHERE id = ?` 
              : `SELECT * FROM ${tableName} ORDER BY id DESC LIMIT 1`;
            const fetchParams = targetId ? [targetId] : [];

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
  syncDatabaseToJson,
  on: (event, handler) => {
    if (pgPool) pgPool.on(event, handler);
  }
};
