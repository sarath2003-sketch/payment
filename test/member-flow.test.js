const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const TEST_PORT = 5098;
process.env.PORT = String(TEST_PORT);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';

const app = require('../index');
const pool = require('../server/config/database');

const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const JWT_SECRET = process.env.JWT_SECRET;

const adminToken = jwt.sign(
  { id: 1, username: 'admin', type: 'admin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

test('MEMBER FLOW AND PAYMENT SUITE', async (t) => {
  const timestamp = Date.now().toString().slice(-6);
  const testPhone = `98${timestamp}12`;
  const testName = `Test Member ${timestamp}`;
  const testPassword = 'Password@123';

  let registeredMemberId = null;
  let registeredDbId = null;
  let secondDbId = null;
  let memberToken = null;

  await t.test('Scenario 1: Public Member Registration assigns sequential ID (>= 101)', async () => {
    const res = await fetch(`${BASE_URL}/api/member-auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: testName,
        phone: testPhone,
        password: testPassword,
        confirmPassword: testPassword
      })
    });

    assert.equal(res.status, 201, `Registration failed with status ${res.status}`);
    const data = await res.json();

    assert.ok(data.token, 'Expected JWT token in registration response');
    assert.ok(data.member_id, 'Expected member_id in registration response');
    const numericId = parseInt(data.member_id, 10);
    assert.ok(!isNaN(numericId) && numericId >= 101, `Member ID ${data.member_id} should be >= 101`);
    assert.equal(data.name, testName);
    assert.equal(data.phone, testPhone);

    registeredMemberId = data.member_id;
    registeredDbId = data.id;
    memberToken = data.token;
  });

  await t.test('Scenario 2: Database Persistence and Sequential Member ID Generation', async () => {
    const dbCheck = await pool.query('SELECT * FROM members WHERE id = $1', [registeredDbId]);
    assert.equal(dbCheck.rows.length, 1, 'Member record should exist in database');
    assert.equal(dbCheck.rows[0].member_id, registeredMemberId, 'member_id in DB must match registered ID');
    assert.equal(dbCheck.rows[0].name, testName);

    const secondPhone = `97${Date.now().toString().slice(-6)}34`;
    const secondName = `Second Member ${Date.now().toString().slice(-4)}`;
    const secondRes = await fetch(`${BASE_URL}/api/member-auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: secondName,
        phone: secondPhone,
        password: testPassword,
        confirmPassword: testPassword
      })
    });

    assert.equal(secondRes.status, 201);
    const secondData = await secondRes.json();
    secondDbId = secondData.id;
    assert.equal(
      parseInt(secondData.member_id, 10),
      parseInt(registeredMemberId, 10) + 1,
      'Next registered member ID must be sequentially incremented'
    );
  });

  await t.test('Scenario 3: Member Login Flexibility', async (t2) => {
    await t2.test('Login with exact Member ID', async () => {
      const res = await fetch(`${BASE_URL}/api/member-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: registeredMemberId, password: testPassword })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
      assert.equal(data.member_id, registeredMemberId);
    });

    await t2.test('Login with SF prefix (SF + ID)', async () => {
      const res = await fetch(`${BASE_URL}/api/member-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: `SF${registeredMemberId}`, password: testPassword })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
      assert.equal(data.member_id, registeredMemberId);
    });

    await t2.test('Login with registered Mobile Number', async () => {
      const res = await fetch(`${BASE_URL}/api/member-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: testPhone, password: testPassword })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
      assert.equal(data.member_id, registeredMemberId);
    });

    await t2.test('Login with Registered Member Name', async () => {
      const res = await fetch(`${BASE_URL}/api/member-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: testName.toLowerCase(), password: testPassword })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
      assert.equal(data.member_id, registeredMemberId);
    });
  });

  await t.test('Scenario 4: Authentication and Dashboard Access (Session Persistence)', async () => {
    const res = await fetch(`${BASE_URL}/api/member-auth/profile`, {
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    assert.equal(res.status, 200);
    const profile = await res.json();
    assert.equal(profile.id, registeredDbId);
    assert.equal(profile.member_id, registeredMemberId);
    assert.equal(profile.name, testName);
  });

  await t.test('Scenario 5: Amount / Payment Entry and Financial Ledger (Credit and Debit)', async () => {
    const creditRes = await fetch(`${BASE_URL}/api/admin/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        member_id: registeredMemberId,
        amount: 1500,
        payment_date: '2026-09-10',
        payment_month: '2026-09',
        transaction_type: 'CREDIT',
        transaction_reference: 'TEST_CREDIT_REF_001',
        description: 'September Monthly Contribution'
      })
    });

    assert.equal(creditRes.status, 201);
    const creditData = await creditRes.json();
    assert.ok(creditData.payment);

    const afterCreditMember = await pool.query('SELECT balance FROM members WHERE id = $1', [registeredDbId]);
    assert.equal(parseFloat(afterCreditMember.rows[0].balance), 1500);

    const debitRes = await fetch(`${BASE_URL}/api/admin/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        member_id: testName,
        amount: 500,
        payment_date: '2026-09-11',
        payment_month: '2026-09',
        transaction_type: 'DEBIT',
        transaction_reference: 'TEST_DEBIT_REF_002',
        description: 'Emergency Fund Payout'
      })
    });

    assert.equal(debitRes.status, 201);

    const afterDebitMember = await pool.query('SELECT balance FROM members WHERE id = $1', [registeredDbId]);
    assert.equal(parseFloat(afterDebitMember.rows[0].balance), 1000);

    const txRes = await fetch(`${BASE_URL}/api/transactions?member_id=${registeredDbId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(txRes.status, 200);
    const txList = await txRes.json();
    assert.ok(txList.length >= 2, 'Should have at least 2 transactions recorded in ledger');

    const hasCredit = txList.some(t => t.transaction_type === 'CREDIT' && parseFloat(t.amount) === 1500);
    const hasDebit = txList.some(t => t.transaction_type === 'DEBIT' && parseFloat(t.amount) === 500);
    assert.ok(hasCredit, 'Ledger must contain CREDIT transaction');
    assert.ok(hasDebit, 'Ledger must contain DEBIT transaction');
  });

  await t.test('Scenario 6: Safe Month Addition (Generate Monthly Dues without data loss)', async () => {
    const res = await fetch(`${BASE_URL}/api/monthly-payments/generate/2026/10`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.created !== undefined, 'Expected created count');

    const dueCheck = await pool.query(
      'SELECT * FROM monthly_payments WHERE member_id = $1 AND year = 2026 AND month = 10',
      [registeredDbId]
    );
    assert.equal(dueCheck.rows.length, 1, 'Monthly payment record for 2026-10 should be created');
  });

  await t.test('Scenario 7: Error Distinction (Not Registered vs Incorrect Password)', async () => {
    const notRegRes = await fetch(`${BASE_URL}/api/member-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_id: '9999999999', password: 'AnyPassword' })
    });
    assert.equal(notRegRes.status, 404);
    const notRegData = await notRegRes.json();
    assert.match(notRegData.error, /not registered/i);

    const wrongPwdRes = await fetch(`${BASE_URL}/api/member-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_id: registeredMemberId, password: 'WrongPassword123' })
    });
    assert.equal(wrongPwdRes.status, 401);
    const wrongPwdData = await wrongPwdRes.json();
    assert.match(wrongPwdData.error, /incorrect password/i);
  });

  await t.test('Scenario 8: Club Expenses Management, Validation & Negative Balance Deduction', async () => {
    // 1. Initial stats
    const statsRes1 = await fetch(`${BASE_URL}/api/admin/members/dashboard-stats`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.equal(statsRes1.status, 200);
    const stats1 = await statsRes1.json();
    const initialBal = parseFloat(stats1.current_balance || 0);
    const initialExp = parseFloat(stats1.total_expenses || 0);

    // 2. Reject negative or invalid expense
    const badRes = await fetch(`${BASE_URL}/api/expenses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', amount: -100 })
    });
    assert.equal(badRes.status, 400);

    // 3. Create ₹1,000 meeting expense
    const testMonth = '2026-09';
    const testAmount = 1000;
    const createRes = await fetch(`${BASE_URL}/api/expenses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Monthly Meeting Refreshments (மாதாந்திர கூட்டம் டீ & பிஸ்கட்)',
        category: 'Food & Refreshments (உணவு & டீ)',
        amount: testAmount,
        expense_date: '2026-09-11',
        expense_month: testMonth,
        remarks: 'Tea and snacks for 20 members'
      })
    });
    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    assert.ok(createData.success);
    const expId = createData.expense.id;

    // 4. Verify in GET /api/expenses?month=2026-09
    const listRes = await fetch(`${BASE_URL}/api/expenses?month=${testMonth}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(listData.expenses.some(e => e.id === expId));
    assert.ok(listData.total_expenses >= testAmount);

    // 5. Verify stats updated: total_expenses increased, balance decreased
    const statsRes2 = await fetch(`${BASE_URL}/api/admin/members/dashboard-stats`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const stats2 = await statsRes2.json();
    assert.equal(parseFloat(stats2.total_expenses), initialExp + testAmount);
    if (initialBal >= testAmount) {
      assert.equal(parseFloat(stats2.current_balance), initialBal - testAmount);
    }

    // 6. Verify monthly statement includes expenses
    const stmtRes = await fetch(`${BASE_URL}/api/public-dashboard/monthly-statement?month=${testMonth}`);
    assert.equal(stmtRes.status, 200);
    const stmtData = await stmtRes.json();
    assert.ok(stmtData.expenses.some(e => e.id === expId));
    assert.ok(stmtData.summary.total_expenses >= testAmount);

    // 7. Delete expense and verify balance restored
    const delRes = await fetch(`${BASE_URL}/api/expenses/${expId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.equal(delRes.status, 200);

    const statsRes3 = await fetch(`${BASE_URL}/api/admin/members/dashboard-stats`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const stats3 = await statsRes3.json();
    assert.equal(parseFloat(stats3.current_balance), initialBal);
  });

  // Clean up all test data created in this test run so DB remains pristine
  try {
    const toClean = [registeredDbId, secondDbId].filter(Boolean);
    for (const mid of toClean) {
      await pool.query('DELETE FROM payment_proofs WHERE member_id = $1', [mid]);
      await pool.query('DELETE FROM transactions WHERE member_id = $1', [mid]);
      await pool.query('DELETE FROM monthly_payments WHERE member_id = $1', [mid]);
      await pool.query('DELETE FROM members WHERE id = $1', [mid]);
    }
  } catch (e) {
    console.warn('Test cleanup notice:', e.message);
  }

  setTimeout(() => process.exit(0), 1000);
});
