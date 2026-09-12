/**
 * Generate transaction ledger records from existing payment_proofs, 
 * seed_fund_distributions, repayments, expenses, and withdrawals
 */
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./server/database/payment_system.sqlite');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

async function main() {
  // Check existing transactions
  const existing = await all('SELECT COUNT(*) as cnt FROM transactions');
  console.log('Existing transactions:', existing[0].cnt);

  if (existing[0].cnt > 0) {
    console.log('Clearing old transactions for clean rebuild...');
    await run('DELETE FROM transactions');
  }

  let insertCount = 0;

  // 1. Generate PAYMENT transactions from payment_proofs (APPROVED)
  const proofs = await all(`
    SELECT pp.*, m.member_id as member_code
    FROM payment_proofs pp
    JOIN members m ON pp.member_id = m.id
    WHERE pp.status = 'APPROVED'
    ORDER BY pp.payment_date ASC, pp.id ASC
  `);
  
  console.log(`\nGenerating ${proofs.length} payment transactions from payment_proofs...`);
  for (const p of proofs) {
    const month = (p.payment_date || p.created_at || '2026-06-10').substring(0, 7);
    const payDate = p.payment_date || p.created_at?.substring(0, 10) || '2026-06-10';
    await run(`
      INSERT INTO transactions (
        member_id, transaction_date, transaction_time, month, 
        transaction_type, amount, description, reference_type, reference_id, status
      ) VALUES (?, ?, '09:00:00', ?, 'PAYMENT', ?, ?, 'PAYMENT_PROOF', ?, 'COMPLETED')
    `, [
      p.member_id,
      payDate,
      month,
      parseFloat(p.amount),
      `மாதாந்திர சந்தா - ${month} (Monthly Payment - Member ${p.member_code})`,
      p.id
    ]);
    insertCount++;
  }
  console.log(`  ✓ Inserted ${proofs.length} payment transactions`);

  // 2. Generate DEBIT transactions for seed fund distributions
  const distributions = await all(`
    SELECT d.*, m.member_id as member_code, m.name as member_name
    FROM seed_fund_distributions d
    JOIN members m ON d.member_id = m.id
    ORDER BY d.distribution_date ASC, d.id ASC
  `);
  
  console.log(`\nGenerating ${distributions.length} distribution (debit) transactions...`);
  for (const d of distributions) {
    const month = d.distribution_date.substring(0, 7);
    const isAuction = d.notes && d.notes.includes('ஏல');
    const type = isAuction ? 'AUCTION_LOAN' : 'STICK_LOAN';
    await run(`
      INSERT INTO transactions (
        member_id, transaction_date, transaction_time, month,
        transaction_type, amount, description, reference_type, reference_id, status
      ) VALUES (?, ?, '10:00:00', ?, 'DEBIT', ?, ?, 'SEED_FUND', ?, 'COMPLETED')
    `, [
      d.member_id,
      d.distribution_date,
      month,
      parseFloat(d.principal_amount),
      `${isAuction ? 'ஏல கடன்' : 'குச்சி கடன்'} - ${d.distribution_date} (${d.member_name} ${d.member_code})`,
      d.id
    ]);
    insertCount++;
  }
  console.log(`  ✓ Inserted ${distributions.length} distribution transactions`);

  // 3. Generate REPAYMENT transactions from repayments table
  const repayments = await all(`
    SELECT r.*, m.member_id as member_code, m.name as member_name
    FROM repayments r
    JOIN members m ON r.member_id = m.id
    WHERE r.status = 'COMPLETED'
    ORDER BY r.payment_date ASC, r.id ASC
  `);
  
  console.log(`\nGenerating ${repayments.length} repayment (credit) transactions...`);
  for (const r of repayments) {
    const month = r.payment_date.substring(0, 7);
    await run(`
      INSERT INTO transactions (
        member_id, transaction_date, transaction_time, month,
        transaction_type, amount, description, reference_type, reference_id, status
      ) VALUES (?, ?, '11:00:00', ?, 'REPAYMENT', ?, ?, 'REPAYMENT', ?, 'COMPLETED')
    `, [
      r.member_id,
      r.payment_date,
      month,
      parseFloat(r.payment_amount),
      `வட்டி திருப்பிச் செலுத்தல் #${r.distribution_id} (${r.member_name} ${r.member_code}) - Ref: ${r.transaction_ref || 'N/A'}`,
      r.id
    ]);
    insertCount++;
  }
  console.log(`  ✓ Inserted ${repayments.length} repayment transactions`);

  // 4. Generate EXPENSE transactions
  const expenses = await all('SELECT * FROM expenses ORDER BY expense_date ASC, id ASC');
  console.log(`\nGenerating ${expenses.length} expense transactions...`);
  for (const e of expenses) {
    const month = (e.expense_month || e.expense_date.substring(0, 7));
    // For expenses, member_id = 1 (admin/club)
    await run(`
      INSERT INTO transactions (
        member_id, transaction_date, transaction_time, month,
        transaction_type, amount, description, reference_type, reference_id, status
      ) VALUES (?, ?, '12:00:00', ?, 'EXPENSE', ?, ?, 'EXPENSE', ?, 'COMPLETED')
    `, [
      1, // admin/system member
      e.expense_date,
      month,
      parseFloat(e.amount),
      `செலவு: ${e.title} (${e.category})`,
      e.id
    ]);
    insertCount++;
  }
  console.log(`  ✓ Inserted ${expenses.length} expense transactions`);

  // 5. Generate WITHDRAWAL transactions
  const withdrawals = await all(`
    SELECT w.*, m.member_id as member_code, m.name as member_name
    FROM withdrawals w
    JOIN members m ON w.member_id = m.id
    ORDER BY w.withdrawal_date ASC, w.id ASC
  `);
  console.log(`\nGenerating ${withdrawals.length} withdrawal transactions...`);
  for (const w of withdrawals) {
    const month = w.month || w.withdrawal_date.substring(0, 7);
    await run(`
      INSERT INTO transactions (
        member_id, transaction_date, transaction_time, month,
        transaction_type, amount, description, reference_type, reference_id, status
      ) VALUES (?, ?, '13:00:00', ?, 'WITHDRAWAL', ?, ?, 'WITHDRAWAL', ?, 'COMPLETED')
    `, [
      w.member_id,
      w.withdrawal_date,
      month,
      parseFloat(w.amount),
      `பணம் திரும்பப்பெறுதல் - ${w.reason} (${w.member_name} ${w.member_code})`,
      w.id
    ]);
    insertCount++;
  }
  console.log(`  ✓ Inserted ${withdrawals.length} withdrawal transactions`);

  // Verify total
  const finalCount = await all('SELECT COUNT(*) as cnt FROM transactions');
  console.log(`\n✅ Total transactions generated: ${finalCount[0].cnt}`);
  console.log(`Expected: ${insertCount}`);

  // Show summary by type
  const byType = await all('SELECT transaction_type, COUNT(*) as cnt, SUM(amount) as total FROM transactions GROUP BY transaction_type ORDER BY transaction_type');
  console.log('\nSummary by type:');
  byType.forEach(r => console.log(`  ${r.transaction_type}: count=${r.cnt}, total=₹${r.total}`));

  db.close();
}
main().catch(console.error);
