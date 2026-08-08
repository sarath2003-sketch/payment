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
      'SELECT COALESCE(SUM(amount), 0) as total FROM monthly_payments WHERE status = $1',
      ['PAID']
    );

    // Total withdrawn
    const withdrawnResult = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals'
    );

    // Current balance
    const balanceResult = await pool.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN transaction_type = 'PAYMENT' THEN amount ELSE -amount END), 0) as balance
       FROM transactions`
    );

    // Recent transactions
    const recentResult = await pool.query(`
      SELECT 
        t.id,
        t.transaction_date,
        m.name,
        t.transaction_type,
        t.amount,
        t.description
      FROM transactions t
      JOIN members m ON t.member_id = m.id
      ORDER BY t.transaction_date DESC
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
        month,
        COUNT(DISTINCT member_id) as members_paid,
        SUM(amount) as total_collected
      FROM monthly_payments
      WHERE status = $1
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `, ['PAID']);

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
        COALESCE(SUM(CASE WHEN mp.status = 'PAID' THEN mp.amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(w.amount), 0) as total_withdrawn,
        COALESCE(SUM(CASE WHEN mp.status = 'PAID' THEN mp.amount ELSE 0 END), 0) - 
        COALESCE(SUM(w.amount), 0) as balance
      FROM members m
      LEFT JOIN monthly_payments mp ON m.id = mp.member_id
      LEFT JOIN withdrawals w ON m.id = w.member_id
      WHERE m.status = $1
      GROUP BY m.id
      ORDER BY balance DESC
    `, ['ACTIVE']);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching member stats:', error);
    res.status(500).json({ error: 'Failed to fetch member stats' });
  }
});

// Get monthly report
router.get('/monthly-report/:month', authenticateToken, async (req, res) => {
  try {
    const { month } = req.params;

    const summaryResult = await pool.query(`
      SELECT 
        $1 as month,
        COUNT(DISTINCT CASE WHEN transaction_type = 'PAYMENT' THEN member_id END) as total_paid_members,
        COALESCE(SUM(CASE WHEN transaction_type = 'PAYMENT' THEN amount ELSE 0 END), 0) as total_collected,
        COALESCE(SUM(CASE WHEN transaction_type = 'WITHDRAWAL' THEN amount ELSE 0 END), 0) as total_withdrawn,
        COALESCE(SUM(CASE WHEN transaction_type = 'PAYMENT' THEN amount ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN transaction_type = 'WITHDRAWAL' THEN amount ELSE 0 END), 0) as balance
      FROM transactions
      WHERE month = $1
    `, [month]);

    const detailsResult = await pool.query(`
      SELECT 
        m.name,
        COALESCE(SUM(CASE WHEN t.transaction_type = 'PAYMENT' THEN t.amount ELSE 0 END), 0) as paid,
        COALESCE(SUM(CASE WHEN t.transaction_type = 'WITHDRAWAL' THEN t.amount ELSE 0 END), 0) as withdrawn
      FROM members m
      LEFT JOIN transactions t ON m.id = t.member_id AND t.month = $1
      GROUP BY m.id
      ORDER BY m.name
    `, [month]);

    res.json({
      summary: summaryResult.rows[0],
      member_details: detailsResult.rows
    });
  } catch (error) {
    console.error('Error fetching monthly report:', error);
    res.status(500).json({ error: 'Failed to fetch monthly report' });
  }
});

module.exports = router;
