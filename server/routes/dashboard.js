const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get dashboard summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    // Total members
    const membersResult = await pool.query('SELECT COUNT(*) as count FROM members WHERE status = $1', ['ACTIVE']);

    // Total collected
    const collectedResult = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM payment_proofs WHERE status = 'APPROVED'"
    );

    // Total withdrawn
    const withdrawnResult = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals'
    );

    // Current balance (sum of member balances)
    const balanceResult = await pool.query(
      'SELECT COALESCE(SUM(balance), 0) as balance FROM members'
    );

    // Recent approved payment proofs
    const recentResult = await pool.query(`
      SELECT 
        pp.id,
        pp.payment_date as transaction_date,
        m.name,
        'PAYMENT' as transaction_type,
        pp.amount,
        pp.transaction_reference as description
      FROM payment_proofs pp
      JOIN members m ON pp.member_id = m.id
      WHERE pp.status = 'APPROVED'
      ORDER BY pp.created_at DESC
      LIMIT 10
    `);

    res.json({
      total_members: parseInt(membersResult.rows[0].count),
      total_collected: parseFloat(collectedResult.rows[0].total),
      total_withdrawn: parseFloat(withdrawnResult.rows[0].total),
      current_balance: parseFloat(balanceResult.rows[0].balance),
      recent_transactions: recentResult.rows
    });
  } catch (error) {
    console.error('Error fetching dashboard summary:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard summary' });
  }
});

// Get monthly collection summary
router.get('/monthly-collection', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        TO_CHAR(payment_date, 'YYYY-MM') as month,
        COUNT(DISTINCT member_id) as members_paid,
        SUM(amount) as total_collected
      FROM payment_proofs
      WHERE status = 'APPROVED'
      GROUP BY TO_CHAR(payment_date, 'YYYY-MM')
      ORDER BY month DESC
      LIMIT 12
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching monthly collection:', error);
    res.status(500).json({ error: 'Failed to fetch monthly collection' });
  }
});

// Get member statistics
router.get('/member-stats', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        m.id,
        m.member_id,
        m.name,
        COALESCE(SUM(CASE WHEN pp.status = 'APPROVED' THEN pp.amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(w.amount), 0) as total_withdrawn,
        m.balance
      FROM members m
      LEFT JOIN payment_proofs pp ON m.id = pp.member_id
      LEFT JOIN withdrawals w ON m.id = w.member_id
      WHERE m.status = 'ACTIVE'
      GROUP BY m.id
      ORDER BY m.name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching member stats:', error);
    res.status(500).json({ error: 'Failed to fetch member stats' });
  }
});

module.exports = router;
