const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * GET PENDING PAYMENT REQUESTS (Admin only)
 * GET /api/admin-payments/pending
 */
router.get('/pending', authenticateToken, async (req, res) => {
  try {
    // Verify admin (non-member auth)
    if (req.admin?.type === 'member') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await pool.query(
      `SELECT 
        pp.id, pp.member_id, m.member_id as member_code, m.name, m.email, m.phone,
        pp.amount, pp.transaction_reference, pp.payment_date, 
        pp.proof_file_path, pp.proof_file_name,
        pp.status, pp.created_at
       FROM payment_proofs pp
       JOIN members m ON pp.member_id = m.id
       WHERE pp.status = 'PENDING'
       ORDER BY pp.created_at ASC`
    );

    res.json({
      count: result.rows.length,
      requests: result.rows
    });

  } catch (error) {
    console.error('Error fetching pending payments:', error);
    res.status(500).json({ error: 'Failed to fetch pending payments' });
  }
});

/**
 * APPROVE PAYMENT (Admin only)
 * POST /api/admin-payments/approve/:proof_id
 */
router.post('/approve/:proof_id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    // Verify admin
    if (req.admin?.type === 'member') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { proof_id } = req.params;

    await client.query('BEGIN');

    // Get payment proof details
    const proofResult = await client.query(
      'SELECT id, member_id, amount, status FROM payment_proofs WHERE id = $1 FOR UPDATE',
      [proof_id]
    );

    if (proofResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment proof not found' });
    }

    const proof = proofResult.rows[0];

    // Check if already approved/rejected
    if (proof.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Payment is already ${proof.status.toLowerCase()}` 
      });
    }

    // Update proof status
    await client.query(
      `UPDATE payment_proofs 
       SET status = 'APPROVED', verified_by = $1, verified_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [req.admin.id || 1, proof_id]
    );

    // Add amount to member balance
    const updateResult = await client.query(
      `UPDATE members 
       SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2
       RETURNING id, member_id, balance, phone, email`,
      [proof.amount, proof.member_id]
    );

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = updateResult.rows[0];

    await client.query('COMMIT');

    // TODO: Send SMS notification to member
    const message = `Your payment of ₹${proof.amount} has been verified and added to your account. Current balance: ₹${member.balance}.`;
    console.log(`[SMS] To ${member.phone}: ${message}`);

    res.json({
      message: 'Payment approved successfully',
      proof_id: proof_id,
      member_id: member.member_id,
      amount_added: proof.amount,
      new_balance: member.balance,
      notification_sent: {
        phone: member.phone,
        email: member.email
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error approving payment:', error);
    res.status(500).json({ error: 'Failed to approve payment' });
  } finally {
    client.release();
  }
});

/**
 * REJECT PAYMENT (Admin only)
 * POST /api/admin-payments/reject/:proof_id
 */
router.post('/reject/:proof_id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    // Verify admin
    if (req.admin?.type === 'member') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { proof_id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason required' });
    }

    await client.query('BEGIN');

    // Get payment proof details
    const proofResult = await client.query(
      'SELECT id, member_id, amount, status FROM payment_proofs WHERE id = $1 FOR UPDATE',
      [proof_id]
    );

    if (proofResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment proof not found' });
    }

    const proof = proofResult.rows[0];

    // Check if already approved/rejected
    if (proof.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Payment is already ${proof.status.toLowerCase()}` 
      });
    }

    // Update proof status
    await client.query(
      `UPDATE payment_proofs 
       SET status = 'REJECTED', rejection_reason = $1, verified_by = $2, verified_at = CURRENT_TIMESTAMP 
       WHERE id = $3`,
      [reason, req.admin.id || 1, proof_id]
    );

    // Get member details for notification
    const memberResult = await client.query(
      'SELECT member_id, phone, email FROM members WHERE id = $1',
      [proof.member_id]
    );

    await client.query('COMMIT');

    if (memberResult.rows.length > 0) {
      const member = memberResult.rows[0];
      // TODO: Send SMS notification to member
      const message = `Your payment request of ₹${proof.amount} could not be verified. Reason: ${reason}. Please contact admin.`;
      console.log(`[SMS] To ${member.phone}: ${message}`);
    }

    res.json({
      message: 'Payment rejected successfully',
      proof_id: proof_id,
      amount: proof.amount,
      rejection_reason: reason
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error rejecting payment:', error);
    res.status(500).json({ error: 'Failed to reject payment' });
  } finally {
    client.release();
  }
});

/**
 * GET ALL PAYMENT REQUESTS (Admin - with filters)
 * GET /api/admin-payments/all?status=PENDING|APPROVED|REJECTED
 */
router.get('/all', authenticateToken, async (req, res) => {
  try {
    // Verify admin
    if (req.admin?.type === 'member') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { status } = req.query;
    let query = `
      SELECT 
        pp.id, pp.member_id, m.member_id as member_code, m.name, m.email, m.phone,
        pp.amount, pp.transaction_reference, pp.payment_date, 
        pp.status, pp.rejection_reason, pp.verified_at, pp.created_at
       FROM payment_proofs pp
       JOIN members m ON pp.member_id = m.id
    `;
    const params = [];

    if (status) {
      query += ' WHERE pp.status = $1';
      params.push(status.toUpperCase());
    }

    query += ' ORDER BY pp.created_at DESC';

    const result = await pool.query(query, params);

    res.json({
      count: result.rows.length,
      requests: result.rows
    });

  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

/**
 * GET PAYMENT STATISTICS (Admin)
 * GET /api/admin-payments/stats
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    // Verify admin
    if (req.admin?.type === 'member') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE status = 'PENDING') as pending_count,
        COUNT(*) FILTER (WHERE status = 'APPROVED') as approved_count,
        COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'APPROVED'), 0) as total_approved_amount,
        COUNT(DISTINCT member_id) as unique_members
       FROM payment_proofs`
    );

    const stats = result.rows[0];

    res.json({
      pending: {
        count: parseInt(stats.pending_count)
      },
      approved: {
        count: parseInt(stats.approved_count),
        total_amount: parseFloat(stats.total_approved_amount)
      },
      rejected: {
        count: parseInt(stats.rejected_count)
      },
      total_members_with_proofs: parseInt(stats.unique_members)
    });

  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

module.exports = router;
