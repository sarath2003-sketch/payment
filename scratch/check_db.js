const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./server/database/payment_system.sqlite');

function run(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, [], (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

async function main() {
  // Check what tables exist
  const tables = await run("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log('TABLES:', tables.map(t=>t.name).join(', '));

  // Check groups
  try {
    const groups = await run('SELECT * FROM groups');
    console.log('GROUPS:', groups.length, JSON.stringify(groups.slice(0,2)));
  } catch(e) { console.log('groups error:', e.message); }

  // Check notice_board
  try {
    const notices = await run('SELECT * FROM notice_board LIMIT 3');
    console.log('NOTICES:', notices.length, JSON.stringify(notices.slice(0,2)));
  } catch(e) { console.log('notice_board error:', e.message); }

  // Check transactions
  try {
    const tx = await run('SELECT COUNT(*) as cnt FROM transactions');
    console.log('TRANSACTIONS count:', tx[0].cnt);
  } catch(e) { console.log('transactions error:', e.message); }

  // Check repayments
  try {
    const rp = await run('SELECT COUNT(*) as cnt FROM repayments');
    console.log('REPAYMENTS count:', rp[0].cnt);
    const rpSample = await run('SELECT * FROM repayments LIMIT 3');
    console.log('REPAYMENTS sample:', JSON.stringify(rpSample));
  } catch(e) { console.log('repayments error:', e.message); }

  // Check payment_proofs
  try {
    const pp = await run('SELECT status, COUNT(*) as cnt FROM payment_proofs GROUP BY status');
    console.log('PAYMENT_PROOFS by status:', JSON.stringify(pp));
  } catch(e) { console.log('payment_proofs error:', e.message); }

  // Check expenses
  try {
    const ex = await run('SELECT * FROM expenses');
    console.log('EXPENSES:', ex.length, JSON.stringify(ex));
  } catch(e) { console.log('expenses error:', e.message); }

  // Check withdrawals
  try {
    const wd = await run('SELECT * FROM withdrawals');
    console.log('WITHDRAWALS:', wd.length, JSON.stringify(wd));
  } catch(e) { console.log('withdrawals error:', e.message); }

  // Check members active count
  try {
    const mems = await run("SELECT status, COUNT(*) as cnt FROM members GROUP BY status");
    console.log('MEMBERS by status:', JSON.stringify(mems));
  } catch(e) { console.log('members error:', e.message); }

  // Check seed_fund_distributions count
  try {
    const sfd = await run("SELECT COUNT(*) as cnt FROM seed_fund_distributions");
    console.log('SEED FUND DISTRIBUTIONS:', sfd[0].cnt);
  } catch(e) { console.log('sfd error:', e.message); }

  // Check monthly_payments
  try {
    const mp = await run("SELECT status, COUNT(*) as cnt FROM monthly_payments GROUP BY status");
    console.log('MONTHLY_PAYMENTS by status:', JSON.stringify(mp));
  } catch(e) { console.log('monthly_payments error:', e.message); }

  db.close();
}
main().catch(console.error);
