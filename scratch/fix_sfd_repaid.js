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
  // Step 1: Get sum of repayments per distribution_id
  const repSums = await all(`
    SELECT distribution_id, SUM(payment_amount) as total_paid
    FROM repayments WHERE status='COMPLETED'
    GROUP BY distribution_id
  `);
  
  console.log('Repayment sums per distribution:');
  repSums.forEach(r => console.log(`  dist #${r.distribution_id}: total_paid=${r.total_paid}`));

  // Step 2: Update each seed_fund_distribution record
  for (const r of repSums) {
    const dist = await all('SELECT * FROM seed_fund_distributions WHERE id = ?', [r.distribution_id]);
    if (dist.length === 0) continue;
    
    const d = dist[0];
    const totalPayable = parseFloat(d.total_payable);
    const totalRepaid = parseFloat(r.total_paid);
    const remaining = Math.max(0, totalPayable - totalRepaid);
    const status = remaining <= 0.01 ? 'PAID' : 'PARTIALLY_PAID';
    
    await run(`
      UPDATE seed_fund_distributions 
      SET total_repaid = ?, remaining_amount = ?, payment_status = ?
      WHERE id = ?
    `, [totalRepaid, remaining, status, r.distribution_id]);
    
    console.log(`Updated dist #${r.distribution_id}: repaid=${totalRepaid}, remaining=${remaining}, status=${status}`);
  }

  // Step 3: Verify final state
  const final = await all("SELECT SUM(total_repaid) as total_repaid, SUM(remaining_amount) as remaining FROM seed_fund_distributions");
  console.log('\nFinal sums:', final[0]);
  
  db.close();
  console.log('\nDone!');
}
main().catch(console.error);
