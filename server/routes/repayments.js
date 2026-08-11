const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET ALL REPAYMENTS
 * GET /api/repayments
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let sql = `
      SELECT r.*, m.name as member_name, m.member_id as member_code, d.principal_amount, d.total_payable
      FROM repayments r
      JOIN members m ON r.member_id = m.id
      JOIN seed_fund_distributions d ON r.distribution_id = d.id
    `;
    let params = [];

    if (req.admin && req.admin.type === 'member') {
      sql += ` WHERE r.member_id = $1`;
      params.push(req.admin.id);
    }

    sql += ` ORDER BY r.id DESC`;

    const result = await pool.query(sql, params);
    res.json({ repayments: result.rows });
  } catch (err) {
    console.error('Error fetching repayments:', err);
    res.status(500).json({ error: 'Failed to fetch repayment history' });
  }
});

/**
 * GET REPAYMENTS FOR SPECIFIC DISTRIBUTION
 * GET /api/repayments/distribution/:distId
 */
router.get('/distribution/:distId', authenticateToken, async (req, res) => {
  try {
    const { distId } = req.params;
    const result = await pool.query(`
      SELECT r.*, m.name as member_name 
      FROM repayments r
      JOIN members m ON r.member_id = m.id
      WHERE r.distribution_id = $1 
      ORDER BY r.id DESC
    `, [distId]);
    res.json({ repayments: result.rows });
  } catch (err) {
    console.error('Error fetching distribution repayments:', err);
    res.status(500).json({ error: 'Failed to fetch repayments for distribution' });
  }
});

/**
 * RECORD A REPAYMENT (ADMIN ONLY)
 * POST /api/repayments
 */
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    let { distribution_id, payment_amount, payment_date, payment_method = 'UPI', transaction_ref, notes } = req.body || {};

    distribution_id = parseInt(distribution_id, 10);
    payment_amount = parseFloat(payment_amount);

    if (!distribution_id || isNaN(payment_amount) || payment_amount <= 0) {
      return res.status(400).json({ error: 'Valid distribution ID and positive payment amount are required.' });
    }

    await client.query('BEGIN');

    // Fetch existing distribution
    const distRes = await client.query(`SELECT * FROM seed_fund_distributions WHERE id = $1 FOR UPDATE`, [distribution_id]);
    if (distRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Distribution record not found.' });
    }

    const dist = distRes.rows[0];
    const currentRemaining = parseFloat(dist.remaining_amount);

    if (payment_amount > currentRemaining + 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Payment amount (₹${payment_amount}) exceeds remaining payable amount (₹${currentRemaining}).` });
    }

    const newTotalRepaid = Math.round((parseFloat(dist.total_repaid || 0) + payment_amount) * 100) / 100;
    const newRemaining = Math.max(0, Math.round((currentRemaining - payment_amount) * 100) / 100);

    let newStatus = 'PARTIALLY_PAID';
    if (newRemaining <= 0.01) {
      newStatus = 'PAID';
    }

    // Update distribution status & remaining
    await client.query(`
      UPDATE seed_fund_distributions 
      SET total_repaid = $1, remaining_amount = $2, payment_status = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [newTotalRepaid, newRemaining, newStatus, distribution_id]);

    const payDate = payment_date || new Date().toISOString().split('T')[0];

    // Insert repayment record
    const repayRes = await client.query(`
      INSERT INTO repayments (
        distribution_id, member_id, payment_amount, payment_date, payment_method, transaction_ref, remaining_amount, status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', $8)
      RETURNING *
    `, [
      distribution_id,
      dist.member_id,
      payment_amount,
      payDate,
      payment_method,
      transaction_ref || null,
      newRemaining,
      notes || null
    ]);

    // Record transaction in ledger
    const monthStr = payDate.substring(0, 7);
    await client.query(`
      INSERT INTO transactions (
        member_id, transaction_date, month, transaction_type, amount, description, reference_type, reference_id, status
      ) VALUES ($1, $2, $3, 'REPAYMENT', $4, $5, 'REPAYMENT', $6, 'COMPLETED')
    `, [
      dist.member_id,
      payDate,
      monthStr,
      payment_amount,
      `Repayment for Fund Distribution #${distribution_id} (Ref: ${transaction_ref || 'N/A'})`,
      repayRes.rows[0].id
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Repayment recorded successfully!',
      repayment: repayRes.rows[0],
      updated_distribution: {
        id: distribution_id,
        total_repaid: newTotalRepaid,
        remaining_amount: newRemaining,
        payment_status: newStatus
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error recording repayment:', err);
    res.status(500).json({ error: 'Failed to record repayment' });
  } finally {
    client.release();
  }
});

module.exports = router;
