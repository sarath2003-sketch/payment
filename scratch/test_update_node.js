const { query } = require('../server/config/database');

async function test() {
  console.log('Before update - member 1:');
  const m1Before = await query('SELECT id, member_id, name, phone FROM members WHERE id = 1');
  console.log(m1Before.rows[0]);

  console.log('Before update - member 20:');
  const m20Before = await query('SELECT id, member_id, name, phone FROM members WHERE id = 20');
  console.log(m20Before.rows[0]);

  console.log('\nRunning UPDATE on id = 1:');
  const res = await query(
    `UPDATE members 
     SET member_id = $1, name = $2, email = $3, phone = $4, upi_id = $5, profile_photo = $6, activation_status = $7, payment_status = $8, group_category = $9, status = $10, password_hash = $11, updated_at = CURRENT_TIMESTAMP
     WHERE id = $12
     RETURNING id, member_id, name, email, phone`,
    ['101', 'Santhosh Test', 'member_9025893352@pfchitfund.com', '9025893352', null, null, 'ACTIVE', 'PAID', 'General', 'ACTIVE', 'hash', 1]
  );
  console.log('Query returned rows:', res.rows);

  console.log('\nAfter update - member 1:');
  const m1After = await query('SELECT id, member_id, name, phone FROM members WHERE id = 1');
  console.log(m1After.rows[0]);

  console.log('After update - member 20:');
  const m20After = await query('SELECT id, member_id, name, phone FROM members WHERE id = 20');
  console.log(m20After.rows[0]);
}
test().catch(console.error);
