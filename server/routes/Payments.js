const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all payments with filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { month, member_id, status } = req.query;
    let query = `
      SELECT 
        mp.id,
        mp.member_id,
        m.name,
        m.member_id as member_code,
        mp.month,
        mp.payment_date,
        mp.amount,
        mp.status,
        mp.payment_method,
        mp.notes,
        mp.created_at,
        mp.updated_at
      FROM monthly_payments mp
      JOIN members m ON mp.member_id = m.id
      WHERE 1=1
    `;
    const params = [];

    if (month) {
      query += ' AND mp.month = $' + (params.length + 1);
      params.push(month);
    }

    if (member_id) {
      query += ' AND mp.member_id = $' + (params.length + 1);
      params.push(member_id);
    }

    if (status) {
      query += ' AND mp.status = $' + (params.length + 1);
      params.push(status);
    }

    query += ' ORDER BY mp.payment_date DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Get payment by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        mp.id,
        mp.member_id,
        m.name,
        m.member_id as member_code,
        mp.month,
        mp.payment_date,
        mp.amount,
        mp.status,
        mp.payment_method,
        mp.notes,
        mp.created_at,
        mp.updated_at
      FROM monthly_payments mp
      JOIN members m ON mp.member_id = m.id
      WHERE mp.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// Create payment (manual entry or after verification)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { member_id, month, payment_date, amount, status, payment_method, notes } = req.body;

    if (!member_id || !month || !payment_date || !amount) {
      return res.status(400).json({ error: 'member_id, month, payment_date, and amount are required' });
    }

    // Check if member exists
    const memberCheck = await pool.query('SELECT id FROM members WHERE id = $1', [member_id]);
    if (memberCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Member not found' });
    }

    const result = await pool.query(
      `INSERT INTO monthly_payments (member_id, month, payment_date, amount, status, payment_method, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [member_id, month, payment_date, amount, status || 'PENDING', payment_method || 'UPI', notes || null]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating payment:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// Update payment
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { month, payment_date, amount, status, payment_method, notes } = req.body;
    
    const result = await pool.query(
      `UPDATE monthly_payments 
       SET month = $1, payment_date = $2, amount = $3, status = $4, payment_method = $5, notes = $6, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $7 RETURNING *`,
      [month, payment_date, amount, status, payment_method, notes, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating payment:', error);
    res.status(500).json({ error: 'Failed to update payment' });
  }
});

// Delete payment
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM monthly_payments WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json({ message: 'Payment deleted successfully' });
  } catch (error) {
    console.error('Error deleting payment:', error);
    res.status(500).json({ error: 'Failed to delete payment' });
  }
});

// Initiate payment flow - creates a pending payment proof record
router.post('/initiate', authenticateToken, async (req, res) => {
  try {
    const { member_id, month, amount } = req.body;

    if (!member_id || !month || !amount) {
      return res.status(400).json({ error: 'member_id, month, and amount are required' });
    }

    // Check if member exists
    const memberCheck = await pool.query('SELECT id FROM members WHERE id = $1', [member_id]);
    if (memberCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Member not found' });
    }

    // Check if payment already exists for this month
    const existingPayment = await pool.query(
      'SELECT id, status FROM monthly_payments WHERE member_id = $1 AND month = $2',
      [member_id, month]
    );

    if (existingPayment.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Payment already exists for this month',
        payment: existingPayment.rows[0]
      });
    }

    // Create payment proof record (PENDING status)
    const proof = await pool.query(
      `INSERT INTO payment_proofs (member_id, month, amount, status, proof_type) 
       VALUES ($1, $2, $3, 'PENDING', 'MANUAL') RETURNING *`,
      [member_id, month, amount]
    );

    res.status(201).json({
      message: 'Payment initiated',
      proof_id: proof.rows[0].id,
      status: 'PENDING',
      next_step: 'Upload payment proof or wait for verification'
    });
  } catch (error) {
    console.error('Error initiating payment:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

module.exports = router;
