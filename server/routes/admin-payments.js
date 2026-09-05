const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { verifyPaymentRules, executePaymentApproval } = require('../services/payment-verifier');

const router = express.Router();

// Helper for audit logging
async function logAudit(req, action, entityType, entityId, details) {
  try {
    const actorId = req.admin?.id || 1;
    const actorName = req.admin?.username || 'Admin';
    const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    
    await pool.query(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details, ip_address)
       VALUES ('ADMIN', $1, $2, $3, $4, $5, $6, $7)`,
      [actorId, actorName, action, entityType, entityId, details ? JSON.stringify(details) : null, ip]
    );
  } catch (err) {
    console.warn('[Audit Log Warning]', err.message);
  }
}

router.use(authenticateToken, requireAdmin);

/**
 * GET /api/admin/payments
 * Get all payment records with filters (status, search, member_id, month)
 */
router.get('/', async (req, res) => {
  try {
    const { status = '', member_id = '', search = '', month = '', page = 1, limit = 50 } = req.query;

    let conditions = [];
    let params = [];

    if (status) {
      if (status === 'APPROVED' || status === 'PAID') {
        conditions.push("(pp.status = 'APPROVED' OR pp.status = 'PAID')");
      } else {
        params.push(status);
        conditions.push(`pp.status = $${params.length}`);
      }
    }

    if (member_id) {
      params.push(member_id);
      conditions.push(`pp.member_id = $${params.length}`);
    }

    if (search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      const pIdx = params.length;
      conditions.push(`(
        LOWER(m.name) LIKE $${pIdx} OR 
        LOWER(m.member_id) LIKE $${pIdx} OR 
        LOWER(COALESCE(pp.transaction_reference, '')) LIKE $${pIdx}
      )`);
    }

    if (month) {
      params.push(`${month}%`);
      conditions.push(`pp.payment_date::text LIKE $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const countRes = await pool.query(
      `SELECT COUNT(*) AS count FROM payment_proofs pp JOIN members m ON pp.member_id = m.id ${whereClause}`,
      params
    );
    const rawCount = countRes.rows[0]?.count ?? countRes.rows[0]?.['COUNT(*)'] ?? countRes.rows[0]?.['count(*)'] ?? 0;
    const total = parseInt(rawCount, 10) || 0;

    params.push(limitNum, offset);
    const sql = `
      SELECT 
        pp.id,
        pp.member_id,
        m.name AS member_name,
        m.member_id AS member_code,
        pp.amount,
        pp.transaction_reference,
        pp.payment_month,
        pp.payment_date,
        pp.proof_file_path,
        pp.status,
        pp.rejection_reason,
        pp.verified_by,
        pp.verified_at,
        pp.created_at
      FROM payment_proofs pp
      JOIN members m ON pp.member_id = m.id
      ${whereClause}
      ORDER BY pp.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const result = await pool.query(sql, params);

    // Compute summary stats for dashboard cards
    let stats = { total_collected: 0, pending_count: 0, approved_count: 0, rejected_count: 0 };
    try {
      const statsRes = await pool.query(`
        SELECT 
          COALESCE(SUM(CASE WHEN status = 'APPROVED' OR status = 'PAID' THEN amount ELSE 0 END), 0) AS total_collected,
          COUNT(CASE WHEN status = 'PENDING' THEN 1 END) AS pending_count,
          COUNT(CASE WHEN status = 'APPROVED' OR status = 'PAID' THEN 1 END) AS approved_count,
          COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) AS rejected_count
        FROM payment_proofs
      `);
      if (statsRes.rows.length > 0) {
        const sr = statsRes.rows[0];
        stats.total_collected = parseFloat(sr.total_collected || sr['total_collected'] || 0);
        stats.pending_count = parseInt(sr.pending_count || sr['pending_count'] || 0, 10);
        stats.approved_count = parseInt(sr.approved_count || sr['approved_count'] || 0, 10);
        stats.rejected_count = parseInt(sr.rejected_count || sr['rejected_count'] || 0, 10);
      }
    } catch (e) {}

    res.json({
      payments: result.rows,
      proofs: result.rows,
      total,
      page: pageNum,
      limit: limitNum,
      stats
    });
  } catch (err) {
    console.error('Error fetching admin payments:', err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

/**
 * GET /api/admin/payments/all-proofs (Legacy support for existing admin frontend calls)
 */
router.get('/all-proofs', async (req, res) => {
  try {
    const { status = '' } = req.query;
    let whereClause = '';
    let params = [];

    if (status) {
      params.push(status);
      whereClause = 'WHERE pp.status = $1';
    }

    const result = await pool.query(
      `SELECT 
        pp.id,
        pp.member_id,
        m.name AS member_name,
        m.member_id AS member_code,
        pp.amount,
        pp.transaction_reference,
        pp.payment_month,
        pp.payment_date,
        pp.proof_file_path,
        pp.status,
        pp.rejection_reason,
        pp.verified_by,
        pp.verified_at,
        pp.created_at
      FROM payment_proofs pp
      JOIN members m ON pp.member_id = m.id
      ${whereClause}
      ORDER BY pp.created_at DESC`,
      params
    );

    res.json({ proofs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment proofs' });
  }
});

/**
 * POST /api/admin/payments
 * Manually add payment record for a member ID
 */
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    let { member_id, amount, payment_date, transaction_reference, status = 'APPROVED', rejection_reason } = req.body;

    if (!member_id || !amount) {
      return res.status(400).json({ error: 'Member ID and amount are required' });
    }

    // Resolve member by numeric id or string member_id (code)
    let memberRes = await client.query('SELECT id, member_id, name FROM members WHERE id = $1 OR member_id = $2', [
      isNaN(parseInt(member_id)) ? -1 : parseInt(member_id),
      String(member_id)
    ]);

    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const member = memberRes.rows[0];

    const pDate = payment_date || new Date().toISOString().split('T')[0];
    const numAmount = parseFloat(amount);

    await client.query('BEGIN');

    const proofRes = await client.query(
      `INSERT INTO payment_proofs (member_id, amount, transaction_reference, payment_date, status, rejection_reason, verified_by, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       RETURNING *`,
      [member.id, numAmount, transaction_reference || `ADMIN_MANUAL_${Date.now()}`, pDate, status, rejection_reason || null, req.admin?.id || 1]
    );

    if (status === 'APPROVED' || status === 'PAID') {
      await client.query('UPDATE members SET balance = balance + $1, payment_status = \'PAID\', updated_at = CURRENT_TIMESTAMP WHERE id = $2', [
        numAmount,
        member.id
      ]);
    }

    await client.query('COMMIT');
    const payment = proofRes.rows[0];

    await logAudit(req, 'ADD_PAYMENT_MANUAL', 'PAYMENT', payment.id, { member_id: member.member_id, amount: numAmount, status });

    res.status(201).json({ message: 'Payment recorded successfully', payment });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error adding manual payment:', err);
    res.status(500).json({ error: err.message || 'Failed to record payment' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/admin/payments/:id
 * Edit existing payment details
 */
router.put('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    let { amount, status, transaction_reference, payment_date, member_id, rejection_reason } = req.body;

    await client.query('BEGIN');

    const existingRes = await client.query('SELECT * FROM payment_proofs WHERE id = $1 FOR UPDATE', [id]);
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment record not found' });
    }

    const existing = existingRes.rows[0];

    // Revert balance if existing was approved
    if (existing.status === 'APPROVED' || existing.status === 'PAID') {
      await client.query('UPDATE members SET balance = balance - $1 WHERE id = $2', [existing.amount, existing.member_id]);
    }

    let targetMemberId = existing.member_id;
    if (member_id) {
      const mCheck = await client.query('SELECT id FROM members WHERE id = $1 OR member_id = $2', [
        isNaN(parseInt(member_id)) ? -1 : parseInt(member_id),
        String(member_id)
      ]);
      if (mCheck.rows.length > 0) targetMemberId = mCheck.rows[0].id;
    }

    const newAmount = amount !== undefined ? parseFloat(amount) : parseFloat(existing.amount);
    const newStatus = status || existing.status;
    const newDate = payment_date || existing.payment_date;
    const newRef = transaction_reference !== undefined ? transaction_reference : existing.transaction_reference;

    const updateRes = await client.query(
      `UPDATE payment_proofs 
       SET member_id = $1, amount = $2, status = $3, transaction_reference = $4, payment_date = $5, rejection_reason = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [targetMemberId, newAmount, newStatus, newRef, newDate, rejection_reason || null, id]
    );

    // Apply new balance if new status is approved
    if (newStatus === 'APPROVED' || newStatus === 'PAID') {
      await client.query('UPDATE members SET balance = balance + $1, payment_status = \'PAID\', updated_at = CURRENT_TIMESTAMP WHERE id = $2', [
        newAmount,
        targetMemberId
      ]);
    }

    await client.query('COMMIT');
    const updatedPayment = (updateRes.rows && updateRes.rows.length > 0 && updateRes.rows[0].id == id)
      ? updateRes.rows[0]
      : { ...existing, id: parseInt(id), member_id: targetMemberId, amount: newAmount, status: newStatus, transaction_reference: newRef, payment_date: newDate, rejection_reason: rejection_reason || null };

    await logAudit(req, 'EDIT_PAYMENT', 'PAYMENT', id, { old: existing, updated: updatedPayment });

    res.json({ message: 'Payment record updated successfully', payment: updatedPayment });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating payment:', err);
    res.status(500).json({ error: 'Failed to update payment record' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/admin/payments/:id
 * Delete incorrect payment record
 */
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const existingRes = await client.query('SELECT * FROM payment_proofs WHERE id = $1 FOR UPDATE', [id]);
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment record not found' });
    }
    const existing = existingRes.rows[0];

    if (existing.status === 'APPROVED' || existing.status === 'PAID') {
      await client.query('UPDATE members SET balance = balance - $1 WHERE id = $2', [existing.amount, existing.member_id]);
    }

    try {
      await client.query("DELETE FROM transactions WHERE reference_type = 'PAYMENT_PROOF' AND reference_id = $1", [id]);
    } catch (e) {}

    await client.query('DELETE FROM payment_proofs WHERE id = $1', [id]);
    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) {
      io.emit('payment:deleted', { id, member_id: existing.member_id });
      if (existing.status === 'APPROVED' || existing.status === 'PAID') {
        io.emit('member:balance-updated', { member_id: existing.member_id, amount: -existing.amount });
      }
    }

    await logAudit(req, 'DELETE_PAYMENT', 'PAYMENT', id, { amount: existing.amount, member_id: existing.member_id });

    res.json({ message: 'Payment record deleted successfully and balance reverted' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to delete payment record' });
  } finally {
    client.release();
  }
});

/**
 * PUT/POST/PATCH /api/admin/payments/:id/approve
 * Instant 1-click payment approval
 */
router.all('/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const existingRes = await client.query('SELECT pp.*, m.name as member_name, m.member_id as member_code FROM payment_proofs pp JOIN members m ON pp.member_id = m.id WHERE pp.id = $1', [id]);
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment record not found' });
    }
    const existing = existingRes.rows[0];

    // If not already approved
    if (existing.status !== 'APPROVED' && existing.status !== 'PAID') {
      await client.query(
        "UPDATE members SET balance = balance + $1, payment_status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [existing.amount, existing.member_id]
      );
    }

    const updateRes = await client.query(
      `UPDATE payment_proofs 
       SET status = 'APPROVED', verified_by = $1, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [req.admin?.id || 1, id]
    );

    // Record into transaction ledger
    const pDate = new Date(existing.payment_date || Date.now());
    const monthStr = `${pDate.getFullYear()}-${String(pDate.getMonth() + 1).padStart(2, '0')}`;
    try {
      await client.query(`
        INSERT INTO transactions (member_id, transaction_date, transaction_time, month, transaction_type, amount, description, reference_type, reference_id, status)
        VALUES ($1, CURRENT_DATE, '12:00:00', $2, 'PAYMENT', $3, $4, 'PAYMENT_PROOF', $5, 'COMPLETED')
      `, [existing.member_id, monthStr, existing.amount, `Payment Approved (Ref: ${existing.transaction_reference || 'N/A'})`, id]);
    } catch (e) {}

    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) {
      io.emit('payment:approved', { proof_id: id, member_id: existing.member_id, amount: existing.amount, status: 'APPROVED' });
      io.emit('member:balance-updated', { member_id: existing.member_id, amount: existing.amount, payment_status: 'PAID' });
      io.emit('notification:broadcast', {
        title: '✅ Payment Approved',
        body: `Payment of ₹${existing.amount} for ${existing.member_name} (${existing.member_code}) has been approved!`
      });
    }

    await logAudit(req, 'APPROVE_PAYMENT', 'PAYMENT', id, { amount: existing.amount, member_id: existing.member_id, member_name: existing.member_name });

    res.json({
      success: true,
      message: `Payment of ₹${existing.amount} for ${existing.member_name} approved and credited!`,
      payment: updateRes.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error approving payment:', err);
    res.status(500).json({ error: 'Failed to approve payment' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/payments/:id
 * Retrieve single payment with member details
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT 
        pp.*,
        m.name AS member_name,
        m.member_id AS member_code,
        m.phone AS member_phone,
        m.balance AS member_balance
      FROM payment_proofs pp
      JOIN members m ON pp.member_id = m.id
      WHERE pp.id = $1
    `, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment record not found' });
    }
    res.json({ payment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

/**
 * POST /api/admin/payments/:id/auto-verify
 * Run auto-verification rules against a pending payment
 */
router.post('/:id/auto-verify', async (req, res) => {
  try {
    const { id } = req.params;
    const existingRes = await pool.query(
      'SELECT pp.*, m.name as member_name, m.member_id as member_code FROM payment_proofs pp JOIN members m ON pp.member_id = m.id WHERE pp.id = $1',
      [id]
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Payment record not found' });
    }
    const payment = existingRes.rows[0];
    if (payment.status === 'APPROVED' || payment.status === 'PAID') {
      return res.json({ success: true, message: 'Payment is already approved and credited', payment });
    }

    const verification = await verifyPaymentRules({
      member_id: payment.member_id,
      amount: payment.amount,
      transaction_reference: payment.transaction_reference,
      payment_id: payment.id
    });

    if (!verification.autoApprove) {
      await pool.query('UPDATE payment_proofs SET rejection_reason = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [verification.reason, id]);
      return res.status(400).json({
        success: false,
        error: `Auto-verification paused: ${verification.reason}`,
        reason: verification.reason
      });
    }

    const io = req.app.get('io');
    const result = await executePaymentApproval({
      payment_id: payment.id,
      member_id: payment.member_id,
      amount: parseFloat(payment.amount),
      transaction_reference: payment.transaction_reference,
      payment_date: payment.payment_date,
      verified_by: req.admin?.id || 1,
      io
    });

    await logAudit(req, 'AUTO_VERIFY_PAYMENT', 'PAYMENT', id, { amount: payment.amount, member_id: payment.member_id });

    res.json({
      success: true,
      message: `Payment #${id} auto-verified! ₹${payment.amount} credited to ${payment.member_name}`,
      payment: result.payment
    });
  } catch (err) {
    console.error('Error in auto-verify:', err);
    res.status(500).json({ error: err.message || 'Auto-verification failed' });
  }
});

/**
 * POST /api/admin/payments/auto-verify-all
 * Batch auto-verify all pending payments that meet business criteria
 */
router.post('/auto-verify-all', async (req, res) => {
  try {
    const pendingRes = await pool.query(
      `SELECT pp.*, m.name as member_name, m.member_id as member_code 
       FROM payment_proofs pp 
       JOIN members m ON pp.member_id = m.id 
       WHERE pp.status = 'PENDING'
       ORDER BY pp.id ASC`
    );
    const pendingList = pendingRes.rows || [];
    let verifiedCount = 0;
    let skippedCount = 0;
    const results = [];
    const io = req.app.get('io');

    for (const payment of pendingList) {
      const verification = await verifyPaymentRules({
        member_id: payment.member_id,
        amount: payment.amount,
        transaction_reference: payment.transaction_reference,
        payment_id: payment.id
      });

      if (verification.autoApprove) {
        await executePaymentApproval({
          payment_id: payment.id,
          member_id: payment.member_id,
          amount: parseFloat(payment.amount),
          transaction_reference: payment.transaction_reference,
          payment_date: payment.payment_date,
          verified_by: req.admin?.id || 1,
          io
        });
        verifiedCount++;
        results.push({ id: payment.id, member_code: payment.member_code, status: 'APPROVED', amount: payment.amount });
      } else {
        await pool.query('UPDATE payment_proofs SET rejection_reason = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [verification.reason, payment.id]);
        skippedCount++;
        results.push({ id: payment.id, member_code: payment.member_code, status: 'SKIPPED', reason: verification.reason });
      }
    }

    await logAudit(req, 'BATCH_AUTO_VERIFY', 'PAYMENT', null, { verifiedCount, skippedCount, total: pendingList.length });

    res.json({
      success: true,
      message: `Batch Auto-Verification complete: ${verifiedCount} auto-verified and approved, ${skippedCount} skipped for manual review.`,
      verified_count: verifiedCount,
      skipped_count: skippedCount,
      total_pending: pendingList.length,
      results
    });
  } catch (err) {
    console.error('Error in batch auto-verify:', err);
    res.status(500).json({ error: 'Batch auto-verification failed' });
  }
});

module.exports = router;
