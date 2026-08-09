const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

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
      `SELECT COUNT(*) FROM payment_proofs pp JOIN members m ON pp.member_id = m.id ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

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

    res.json({
      payments: result.rows,
      proofs: result.rows,
      total,
      page: pageNum,
      limit: limitNum
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
    const updatedPayment = updateRes.rows[0];

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

    await client.query('DELETE FROM payment_proofs WHERE id = $1', [id]);
    await client.query('COMMIT');

    await logAudit(req, 'DELETE_PAYMENT', 'PAYMENT', id, { amount: existing.amount, member_id: existing.member_id });

    res.json({ message: 'Payment record deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to delete payment record' });
  } finally {
    client.release();
  }
});

module.exports = router;
