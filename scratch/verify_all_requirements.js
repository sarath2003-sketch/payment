const http = require('http');

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'object' ? JSON.stringify(body) : body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('===========================================================');
  console.log('🚀 MASTER SUITE — PF CHIT FUND CLUB COMPREHENSIVE VERIFICATION');
  console.log('===========================================================');

  const BASE = 'http://localhost:5000';
  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      failed++;
    }
  }

  // 1. Public Portal Financial Summary
  try {
    const res = await request(`${BASE}/api/public-dashboard/summary`);
    assert(res.status === 200 && res.body.success, 'Public Portal Summary API accessible without token');
    const m = res.body.metrics || {};
    assert(m.available_amount !== undefined, 'Available Amount field present in metrics');
    assert(m.total_expenses !== undefined, 'Total Expenses field present in metrics');
    assert(m.amount_after_expenses !== undefined, 'Amount After Expenses field present in metrics');
    assert(m.distributed_amount !== undefined, 'Distributed Amount field present in metrics');
    assert(m.remaining_balance !== undefined, 'Remaining Balance field present in metrics');
    console.log(`      -> Available: ₹${m.available_amount}, Expenses: ₹${m.total_expenses}, After Expenses: ₹${m.amount_after_expenses}, Distributed: ₹${m.distributed_amount}, Remaining Balance: ₹${m.remaining_balance}`);
  } catch (e) { assert(false, 'Public Portal Summary API error: ' + e.message); }

  // 2. Admin Login
  let adminToken = '';
  try {
    const res = await request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'admin', password: 'Admin@123456' });
    assert(res.status === 200 && res.body.token, 'Admin login succeeded with Admin@123456');
    adminToken = res.body.token;
  } catch (e) { assert(false, 'Admin login error: ' + e.message); }

  const authHeaders = {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json'
  };

  // 3. Public Members Listing (View-Only, No Auth)
  try {
    const res = await request(`${BASE}/api/members/public`);
    const members = Array.isArray(res.body) ? res.body : (res.body.members || []);
    assert(res.status === 200 && Array.isArray(members), 'Public Members List accessible without token');
    assert(members.length >= 20, `Public Members List contains ${members.length} members`);
  } catch (e) { assert(false, 'Public Members API error: ' + e.message); }

  // 4. Member Edit Flow Verification
  try {
    const editRes = await request(`${BASE}/api/admin/members/1`, {
      method: 'PUT',
      headers: authHeaders
    }, {
      member_id: '101',
      name: 'Santhosh Verified',
      phone: '9025893352',
      upi_id: 'santhosh@cnrb',
      activation_status: 'ACTIVE',
      payment_status: 'PAID'
    });
    assert(editRes.status === 200 && editRes.body.member && editRes.body.member.id === 1 && editRes.body.member.name === 'Santhosh Verified', 'Member Edit updated correct member (ID 1) in DB');

    // Revert edit
    await request(`${BASE}/api/admin/members/1`, {
      method: 'PUT',
      headers: authHeaders
    }, {
      member_id: '101',
      name: 'Santhosh',
      phone: '9025893352',
      upi_id: null,
      activation_status: 'ACTIVE',
      payment_status: 'PAID'
    });
    console.log('      -> Member 1 successfully reverted back to original name');
  } catch (e) { assert(false, 'Member Edit error: ' + e.message); }

  // 5. Expenses CRUD & Calculation Verification
  try {
    const initialExps = await request(`${BASE}/api/expenses`);
    const initialTotal = initialExps.body.total_expenses || 0;

    // Add expense
    const addRes = await request(`${BASE}/api/expenses`, {
      method: 'POST',
      headers: authHeaders
    }, {
      title: 'Automated Test Expense',
      category: 'General',
      amount: 400,
      expense_date: '2026-09-12',
      remarks: 'Master test script'
    });
    assert(addRes.status === 201 && addRes.body.expense && addRes.body.expense.id, 'Expense created successfully');
    const newExpId = addRes.body.expense.id;

    const afterAdd = await request(`${BASE}/api/expenses`);
    assert(afterAdd.body.total_expenses === initialTotal + 400, `Total Expenses auto-calculated after Add (₹${afterAdd.body.total_expenses})`);

    // Edit expense
    await request(`${BASE}/api/expenses/${newExpId}`, {
      method: 'PUT',
      headers: authHeaders
    }, {
      title: 'Automated Test Expense (Updated)',
      category: 'General',
      amount: 500,
      expense_date: '2026-09-12',
      remarks: 'Master test script updated'
    });

    const afterEdit = await request(`${BASE}/api/expenses`);
    assert(afterEdit.body.total_expenses === initialTotal + 500, `Total Expenses auto-calculated after Edit (₹${afterEdit.body.total_expenses})`);

    // Delete expense
    await request(`${BASE}/api/expenses/${newExpId}`, {
      method: 'DELETE',
      headers: authHeaders
    });

    const afterDel = await request(`${BASE}/api/expenses`);
    assert(afterDel.body.total_expenses === initialTotal, `Total Expenses auto-calculated after Delete (₹${afterDel.body.total_expenses})`);
  } catch (e) { assert(false, 'Expenses CRUD error: ' + e.message); }

  // 6. Transaction Ledger Public & Admin Access
  try {
    const res = await request(`${BASE}/api/transactions/public`);
    const txs = Array.isArray(res.body) ? res.body : (res.body.transactions || []);
    assert(res.status === 200 && Array.isArray(txs), 'Transaction Ledger accessible for Public view');
    assert(txs.length >= 100, `Transaction Ledger contains ${txs.length} real transactions`);
  } catch (e) { assert(false, 'Transaction Ledger API error: ' + e.message); }

  // 7. Notice Board Public & Admin Access
  try {
    const pubNotices = await request(`${BASE}/api/notices/public`);
    const notices = Array.isArray(pubNotices.body) ? pubNotices.body : (pubNotices.body.notices || []);
    assert(pubNotices.status === 200 && Array.isArray(notices), 'Notice Board accessible for Public view');

    const addNotice = await request(`${BASE}/api/notices`, {
      method: 'POST',
      headers: authHeaders
    }, {
      title: 'Master Test Notice',
      description: 'System sanity test notice',
      target_type: 'ALL',
      status: 'PUBLISHED'
    });
    assert(addNotice.status === 201 && addNotice.body.notice && addNotice.body.notice.id, 'Notice created by Admin');
    const noticeId = addNotice.body.notice.id;

    // Delete test notice
    await request(`${BASE}/api/notices/${noticeId}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    console.log('      -> Test Notice deleted successfully');
  } catch (e) { assert(false, 'Notice Board API error: ' + e.message); }

  // 8. Payment Verification Pending Proofs
  try {
    const res = await request(`${BASE}/api/payment-verification/pending-proofs`, {
      headers: authHeaders
    });
    const proofs = Array.isArray(res.body) ? res.body : (res.body.proofs || []);
    assert(res.status === 200 && Array.isArray(proofs), 'Payment Verification pending proofs endpoint accessible for Admin');
  } catch (e) { assert(false, 'Payment Verification error: ' + e.message); }

  // 9. Repayments Public Access
  try {
    const res = await request(`${BASE}/api/repayments/public`);
    const repayments = Array.isArray(res.body) ? res.body : (res.body.repayments || []);
    assert(res.status === 200 && Array.isArray(repayments), 'Repayments history accessible for Public view');
    assert(repayments.length >= 18, `Repayments history contains ${repayments.length} records`);
  } catch (e) { assert(false, 'Repayments API error: ' + e.message); }

  // 10. Groups Management Public Access
  try {
    const res = await request(`${BASE}/api/groups/public`);
    const groups = Array.isArray(res.body) ? res.body : (res.body.groups || []);
    assert(res.status === 200 && Array.isArray(groups), 'Groups list accessible for Public view');
    assert(groups.length >= 1, `Groups list contains ${groups.length} groups`);
  } catch (e) { assert(false, 'Groups API error: ' + e.message); }

  // 11. Security Check: Reject Unauthenticated Mutation Calls
  try {
    const res = await request(`${BASE}/api/admin/members/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' }
    }, { name: 'Hacker Edit' });
    assert(res.status === 401 || res.status === 403, 'Unauthenticated Admin mutation rejected with HTTP 401/403 Security Error');
  } catch (e) { assert(false, 'Security Check error: ' + e.message); }

  console.log('\n===========================================================');
  console.log(`📊 FINAL RESULT: ${passed} PASSED, ${failed} FAILED`);
  console.log('===========================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
