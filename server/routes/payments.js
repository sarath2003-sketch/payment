const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all payment proofs / monthly payments with filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { year, month, member_id, status } = req.query;
    let query = `
      SELECT 
        pp.id,
        pp.member_id,
        m.name,
        m.member_id as member_code,
        pp.payment_date,
        pp.amount,
        pp.transaction_reference,
        pp.status,
        pp.rejection_reason,
        pp.proof_file_path,
        pp.created_at,
        pp.updated_at
      FROM payment_proofs pp
      JOIN members m ON pp.member_id = m.id
      WHERE 1=1
    `;
    const params = [];

    if (member_id) {
      query += ' AND pp.member_id = $' + (params.length + 1);
      params.push(member_id);
    }

    if (status) {
      query += ' AND pp.status = $' + (params.length + 1);
      params.push(status.toUpperCase());
    }

    if (year && month) {
      query += ` AND TO_CHAR(pp.payment_date, 'YYYY-MM') = $` + (params.length + 1);
      params.push(`${year}-${String(month).padStart(2, '0')}`);
    }

    query += ' ORDER BY pp.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Get payment proof by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        pp.id,
        pp.member_id,
        m.name,
        m.member_id as member_code,
        pp.payment_date,
        pp.amount,
        pp.transaction_reference,
        pp.status,
        pp.rejection_reason,
        pp.proof_file_path,
        pp.created_at,
        pp.updated_at
      FROM payment_proofs pp
      JOIN members m ON pp.member_id = m.id
      WHERE pp.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment record not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

module.exports = router;
