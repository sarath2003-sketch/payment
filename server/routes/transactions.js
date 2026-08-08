const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all transactions with filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { month, member_id, transaction_type, startDate, endDate } = req.query;
    let query = `
      SELECT 
        t.id,
        t.member_id,
        m.name,
        m.member_id as member_code,
        t.transaction_date,
        t.month,
        t.transaction_type,
        t.amount,
        t.description,
        t.balance_after
      FROM transactions t
      JOIN members m ON t.member_id = m.id
      WHERE 1=1
    `;
    const params = [];

    if (month) {
      query += ' AND t.month = $' + (params.length + 1);
      params.push(month);
    }

    if (member_id) {
      query += ' AND t.member_id = $' + (params.length + 1);
      params.push(member_id);
    }

    if (transaction_type) {
      query += ' AND t.transaction_type = $' + (params.length + 1);
      params.push(transaction_type);
    }

    if (startDate) {
      query += ' AND t.transaction_date >= $' + (params.length + 1);
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND t.transaction_date <= $' + (params.length + 1);
      params.push(endDate);
    }

    query += ' ORDER BY t.transaction_date DESC, t.id DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Get transaction by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM transactions WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching transaction:', error);
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

// Get monthly summary
router.get('/summary/monthly', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        month,
        transaction_type,
        COUNT(*) as transaction_count,
        SUM(amount) as total_amount
      FROM transactions
      GROUP BY month, transaction_type
      ORDER BY month DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching monthly summary:', error);
    res.status(500).json({ error: 'Failed to fetch monthly summary' });
  }
});

// Get member transaction summary
router.get('/member/:memberId/summary', authenticateToken, async (req, res) => {
  try {
    const { memberId } = req.params;

    const result = await pool.query(`
      SELECT 
        m.id,
        m.name,
        m.member_id as member_code,
        COALESCE(SUM(CASE WHEN t.transaction_type = 'PAYMENT' THEN t.amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN t.transaction_type = 'WITHDRAWAL' THEN t.amount ELSE 0 END), 0) as total_withdrawn,
        COALESCE(SUM(CASE WHEN t.transaction_type = 'PAYMENT' THEN t.amount ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN t.transaction_type = 'WITHDRAWAL' THEN t.amount ELSE 0 END), 0) as current_balance
      FROM members m
      LEFT JOIN transactions t ON m.id = t.member_id
      WHERE m.id = $1
      GROUP BY m.id
    `, [memberId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching member summary:', error);
    res.status(500).json({ error: 'Failed to fetch member summary' });
  }
});

module.exports = router;
