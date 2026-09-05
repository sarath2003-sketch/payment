const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5000';

async function request(url, options = {}) {
  const res = await fetch(BASE + url, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, data: json };
}

async function runTests() {
  console.log('============================================================');
  console.log('🧪 Starting End-to-End Local Storage & Auto-Verify/CRUD Tests');
  console.log('============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) {
      console.log(`✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${msg}`);
      failed++;
    }
  }

  // 1. Check Localhost Storage
  console.log('--- 1. Testing Localhost Storage ---');
  const sqliteFile = path.join(__dirname, '..', 'server', 'database', 'payment_system.sqlite');
  assert(fs.existsSync(sqliteFile), `SQLite database exists on localhost disk (${sqliteFile})`);
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  assert(fs.existsSync(uploadsDir), `Uploads directory exists on localhost disk (${uploadsDir})`);

  // 2. Admin Login
  console.log('\n--- 2. Admin Login ---');
  const adminRes = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin@123456' })
  });
  assert(adminRes.ok && adminRes.data.token, 'Admin login succeeded and received JWT');
  const adminToken = adminRes.data.token;

  // 3. Register a Test Member
  console.log('\n--- 3. Member Registration ---');
  const testPhone = '98' + Math.floor(10000000 + Math.random() * 90000000);
  const regRes = await request('/api/member-auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'AutoVerify Test Member',
      phone: testPhone,
      password: 'password123',
      confirmPassword: 'password123'
    })
  });
  assert(regRes.ok && regRes.data.member_id, `Member registered with ID ${regRes.data.member_id}`);
  const memberToken = regRes.data.token;
  const memberDbId = regRes.data.id;

  // 4. Test Auto-Verification: Valid ₹500 with unique UTR
  console.log('\n--- 4. Test Auto-Verification (Valid ₹500 + Unique UTR) ---');
  const validUtr = 'UTR' + Date.now();
  const sampleImagePath = path.join(__dirname, 'sample_receipt.png');
  // Create a 1x1 dummy png if missing
  if (!fs.existsSync(sampleImagePath)) {
    const dummyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(sampleImagePath, dummyPng);
  }

  // Upload proof using FormData
  const formData = new FormData();
  const fileBuffer = fs.readFileSync(sampleImagePath);
  const blob = new Blob([fileBuffer], { type: 'image/png' });
  formData.append('proof', blob, 'receipt.png');
  formData.append('member_id', memberDbId);
  formData.append('amount', '500');
  formData.append('payment_date', '2026-09-05');
  formData.append('payment_month', '2026-09');
  formData.append('transaction_reference', validUtr);

  const uploadRes = await request('/api/payment-verification/upload-proof', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}` },
    body: formData
  });

  assert(uploadRes.ok, 'Upload payment proof HTTP 200 OK');
  assert(uploadRes.data.auto_approved === true, 'Payment was AUTO-APPROVED by engine');
  assert(uploadRes.data.status === 'APPROVED', 'Payment status is APPROVED');
  const approvedPaymentId = uploadRes.data.proof_id;

  // Check member balance credited
  const profileRes = await request('/api/member-auth/profile', {
    headers: { Authorization: `Bearer ${memberToken}` }
  });
  assert(parseFloat(profileRes.data.balance) === 500, `Member balance updated to ₹500 (actual: ₹${profileRes.data.balance})`);
  assert(profileRes.data.payment_status === 'PAID', 'Member payment_status is PAID');

  // 5. Test Auto-Verification: Invalid Amount (₹350 instead of ₹500)
  console.log('\n--- 5. Test Auto-Verification Pauses on Amount Mismatch ---');
  const mismatchUtr = 'UTR_MISMATCH_' + Date.now();
  const fd2 = new FormData();
  fd2.append('proof', blob, 'receipt2.png');
  fd2.append('member_id', memberDbId);
  fd2.append('amount', '350');
  fd2.append('payment_date', '2026-09-05');
  fd2.append('payment_month', '2026-09');
  fd2.append('transaction_reference', mismatchUtr);

  const uploadRes2 = await request('/api/payment-verification/upload-proof', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}` },
    body: fd2
  });

  assert(uploadRes2.ok, 'Upload proof 2 HTTP 200 OK');
  assert(uploadRes2.data.auto_approved === false, 'Payment was NOT auto-approved (amount mismatch)');
  assert(uploadRes2.data.status === 'PENDING', 'Payment status remains PENDING');
  const pendingPaymentId = uploadRes2.data.proof_id;

  // 6. Test Auto-Verification: Duplicate UTR Detection
  console.log('\n--- 6. Test Auto-Verification Flags Duplicate UTR ---');
  const fd3 = new FormData();
  fd3.append('proof', blob, 'receipt3.png');
  fd3.append('member_id', memberDbId);
  fd3.append('amount', '500');
  fd3.append('payment_date', '2026-09-05');
  fd3.append('payment_month', '2026-09');
  fd3.append('transaction_reference', validUtr); // REUSED UTR!

  const uploadRes3 = await request('/api/payment-verification/upload-proof', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}` },
    body: fd3
  });

  assert(uploadRes3.ok, 'Upload proof 3 HTTP 200 OK');
  assert(uploadRes3.data.auto_approved === false, 'Payment was NOT auto-approved (duplicate UTR)');
  assert(uploadRes3.data.status === 'PENDING', 'Duplicate UTR payment remains PENDING for review');
  assert(uploadRes3.data.note && uploadRes3.data.note.includes('Duplicate UTR'), 'Rejection note mentions Duplicate UTR');

  // 7. Test SELECT CRUD Method (List, Filters & Stats)
  console.log('\n--- 7. Test SELECT Method (GET /api/admin/payments) ---');
  const listRes = await request('/api/admin/payments', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert(listRes.ok && Array.isArray(listRes.data.proofs), 'GET /api/admin/payments returns payments array');
  assert(listRes.data.stats && listRes.data.stats.approved_count >= 1, `Stats returns approved count (${listRes.data.stats?.approved_count})`);
  assert(listRes.data.stats && listRes.data.stats.total_collected >= 500, `Stats returns total collected (₹${listRes.data.stats?.total_collected})`);

  // Test single GET by ID
  const singleRes = await request(`/api/admin/payments/${approvedPaymentId}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert(singleRes.ok && singleRes.data.payment?.id == approvedPaymentId, `GET /api/admin/payments/${approvedPaymentId} returns payment details`);

  // 8. Test UPDATE CRUD Method (Edit Payment Record)
  console.log('\n--- 8. Test UPDATE Method (PUT /api/admin/payments/:id) ---');
  const updateRes = await request(`/api/admin/payments/${pendingPaymentId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      amount: 500,
      status: 'APPROVED',
      transaction_reference: mismatchUtr + '_FIXED',
      payment_date: '2026-09-05'
    })
  });
  assert(updateRes.ok, 'PUT /api/admin/payments/:id returned 200 OK');
  assert(updateRes.data.payment?.status === 'APPROVED', 'Updated payment status is APPROVED');

  // Check member balance adjusted
  const profileResAfterEdit = await request('/api/member-auth/profile', {
    headers: { Authorization: `Bearer ${memberToken}` }
  });
  assert(parseFloat(profileResAfterEdit.data.balance) === 1000, `Member balance updated to ₹1000 after second approval (actual: ₹${profileResAfterEdit.data.balance})`);

  // 9. Test DELETE CRUD Method with Safe Balance Rollback
  console.log('\n--- 9. Test DELETE Method (DELETE /api/admin/payments/:id) ---');
  const deleteRes = await request(`/api/admin/payments/${pendingPaymentId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert(deleteRes.ok, `DELETE /api/admin/payments/${pendingPaymentId} returned 200 OK`);

  // Check member balance deducted back by 500
  const profileResAfterDelete = await request('/api/member-auth/profile', {
    headers: { Authorization: `Bearer ${memberToken}` }
  });
  assert(parseFloat(profileResAfterDelete.data.balance) === 500, `Member balance rolled back safely from ₹1000 to ₹500 (actual: ₹${profileResAfterDelete.data.balance})`);

  // 10. Test BATCH AUTO-VERIFY Endpoint
  console.log('\n--- 10. Test Batch Auto-Verify Endpoint (/auto-verify-all) ---');
  const batchRes = await request('/api/admin/payments/auto-verify-all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert(batchRes.ok, 'POST /api/admin/payments/auto-verify-all returned 200 OK');
  assert(typeof batchRes.data.verified_count === 'number', `Batch auto-verify reported verified count: ${batchRes.data.verified_count}`);

  console.log('\n============================================================');
  console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('============================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});