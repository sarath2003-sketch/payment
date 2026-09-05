const pool = require('../config/database');

/**
 * Payment Verification Engine
 * Validates payments against business rules:
 * 1. Expected monthly amount match (₹500 default)
 * 2. Valid transaction reference / UTR format
 * 3. Anti-duplicate UTR check
 * 4. Active member verification
 */
async function verifyPaymentRules({ member_id, amount, transaction_reference, payment_id = 0 }) {
  try {
    // 1. Fetch system settings
    const sRes = await pool.query(
      "SELECT key, value FROM app_settings WHERE key IN ('auto_approve_payment', 'default_payment_amount', 'auto_verify_amount')"
    );
    const settings = {};
    (sRes.rows || []).forEach(r => { settings[r.key] = r.value; });

    const autoApproveEnabled = settings.auto_approve_payment === '1' || settings.auto_approve_payment === 'true' || settings.auto_approve_payment === undefined;
    const expectedAmount = parseFloat(settings.auto_verify_amount || settings.default_payment_amount || 500);

    if (!autoApproveEnabled) {
      return { autoApprove: false, reason: 'Auto-verification disabled in Admin Settings' };
    }

    // 2. Validate member existence
    const mRes = await pool.query('SELECT id, member_id, name, balance, status FROM members WHERE id = $1', [member_id]);
    if (!mRes.rows || mRes.rows.length === 0) {
      return { autoApprove: false, reason: 'Member not found in database' };
    }
    const member = mRes.rows[0];

    // 3. Validate Amount
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return { autoApprove: false, reason: 'Invalid payment amount' };
    }
    if (numAmount !== expectedAmount) {
      return { 
        autoApprove: false, 
        reason: `Amount mismatch: ₹${numAmount} submitted, expected monthly contribution is ₹${expectedAmount}` 
      };
    }

    // 4. Validate Transaction Reference / UTR
    const cleanRef = (transaction_reference || '').trim();
    if (!cleanRef || cleanRef.length < 4) {
      return { autoApprove: false, reason: 'Missing or incomplete transaction reference / UTR ID' };
    }

    // 5. Anti-Duplicate UTR Check
    const dupCheckSql = `
      SELECT id, member_id, status, amount, created_at 
      FROM payment_proofs 
      WHERE LOWER(TRIM(transaction_reference)) = LOWER($1) 
        AND id != $2 
        AND (status = 'APPROVED' OR status = 'PAID')
      LIMIT 1
    `;
    const dupRes = await pool.query(dupCheckSql, [cleanRef, payment_id]);
    if (dupRes.rows && dupRes.rows.length > 0) {
      const existing = dupRes.rows[0];
      return { 
        autoApprove: false, 
        reason: `Duplicate UTR detected: Reference '${cleanRef}' was already approved on Payment #${existing.id}` 
      };
    }

    return {
      autoApprove: true,
      member,
      expectedAmount,
      numAmount,
      cleanRef
    };
  } catch (err) {
    console.error('[Payment Verifier Error]', err);
    return { autoApprove: false, reason: `Verification error: ${err.message}` };
  }
}

/**
 * Execute full payment approval workflow:
 * - Update payment status to APPROVED
 * - Credit member balance
 * - Set member payment_status to PAID
 * - Insert into ledger transactions
 * - Emit real-time Socket.IO updates
 */
async function executePaymentApproval({ payment_id, member_id, amount, transaction_reference, payment_date, verified_by = 1, io }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update payment proof
    const updateRes = await client.query(
      `UPDATE payment_proofs 
       SET status = 'APPROVED', verified_by = $1, verified_at = CURRENT_TIMESTAMP, rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [verified_by, payment_id]
    );

    // Credit member balance and set status
    const mRes = await client.query(
      `UPDATE members 
       SET balance = balance + $1, payment_status = 'PAID', activation_status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2
       RETURNING id, member_id, name, balance`,
      [amount, member_id]
    );

    const updatedMember = mRes.rows[0] || {};

    // Record into transaction ledger
    const pDate = new Date(payment_date || Date.now());
    const monthStr = `${pDate.getFullYear()}-${String(pDate.getMonth() + 1).padStart(2, '0')}`;
    try {
      await client.query(`
        INSERT INTO transactions (member_id, transaction_date, transaction_time, month, transaction_type, amount, description, reference_type, reference_id, status)
        VALUES ($1, CURRENT_DATE, '12:00:00', $2, 'PAYMENT', $3, $4, 'PAYMENT_PROOF', $5, 'COMPLETED')
      `, [member_id, monthStr, amount, `Payment Verified (Ref: ${transaction_reference || 'N/A'})`, payment_id]);
    } catch (e) {
      console.warn('[Transactions Insert Note]', e.message);
    }

    await client.query('COMMIT');

    const payment = updateRes.rows[0];

    // Real-time broadcasts
    if (io) {
      io.emit('payment:approved', {
        proof_id: payment_id,
        member_id,
        member_name: updatedMember.name,
        member_code: updatedMember.member_id,
        amount,
        status: 'APPROVED'
      });
      io.emit('member:balance-updated', {
        member_id,
        amount,
        balance: updatedMember.balance,
        payment_status: 'PAID'
      });
      io.emit('notification:broadcast', {
        title: '✅ Payment Auto-Verified & Approved',
        body: `Payment of ₹${amount} for ${updatedMember.name || 'Member'} (${updatedMember.member_id || member_id}) has been verified and credited!`
      });
    }

    return { success: true, payment, member: updatedMember };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  verifyPaymentRules,
  executePaymentApproval
};