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
  // Check monthly_payments totals
  const mp = await run("SELECT SUM(amount_paid) as total, COUNT(*) as cnt FROM monthly_payments WHERE status='PAID'");
  console.log('Monthly payments total:', mp[0]);

  // Check payment_proofs totals
  const pp = await run("SELECT SUM(amount) as total, COUNT(*) as cnt FROM payment_proofs WHERE status='APPROVED'");
  console.log('Payment proofs total:', pp[0]);

  // Check repayments totals
  const rp = await run("SELECT SUM(payment_amount) as total, COUNT(*) as cnt FROM repayments WHERE status='COMPLETED'");
  console.log('Repayments total:', rp[0]);

  // Check seed fund distributions
  const sfd = await run("SELECT SUM(principal_amount) as total_principal, SUM(interest_amount) as total_interest, SUM(total_payable) as total_payable, SUM(total_repaid) as total_repaid, SUM(remaining_amount) as remaining FROM seed_fund_distributions");
  console.log('Seed fund distributions:', sfd[0]);

  // Check individual distribution details
  const sfdDetail = await run("SELECT id, member_id, principal_amount, interest_amount, total_payable, total_repaid, remaining_amount, payment_status FROM seed_fund_distributions ORDER BY id");
  console.log('SFD Detail:');
  sfdDetail.forEach(r => console.log(`  #${r.id}: principal=${r.principal_amount}, interest=${r.interest_amount}, payable=${r.total_payable}, repaid=${r.total_repaid}, remaining=${r.remaining_amount}`));

  // Check expenses
  const ex = await run("SELECT SUM(amount) as total FROM expenses");
  console.log('Expenses total:', ex[0]);

  // Check withdrawals
  const wd = await run("SELECT SUM(amount) as total FROM withdrawals");
  console.log('Withdrawals total:', wd[0]);

  db.close();
}
main().catch(console.error);
