const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all withdrawals
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { month, member_id } = req.query;
    let query = `
      SELECT 
        w.id,
        w.member_id,
        m.name,
        m.member_id as member_code,
        w.month,
        w.withdrawal_date,
        w.amount,
        w.reason,
        w.notes
      FROM withdrawals w
      JOIN members m ON w.member_id = m.id
      WHERE 1=1
    `;
    const params = [];

    if (month) {
      query += ' AND w.month = $' + (params.length + 1);
      params.push(month);
    }

    if (member_id) {
      query += ' AND w.member_id = $' + (params.length + 1);
      params.push(member_id);
    }

    query += ' ORDER BY w.withdrawal_date DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching withdrawals:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// Get withdrawal by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM withdrawals WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching withdrawal:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawal' });
  }
});

// Create new withdrawal
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { member_id, month, withdrawal_date, amount, reason, notes } = req.body;

    if (!member_id || !month || !withdrawal_date || !amount) {
      return res.status(400).json({ error: 'Required fields: member_id, month, withdrawal_date, amount' });
    }

    const result = await pool.query(
      `INSERT INTO withdrawals 
       (member_id, month, withdrawal_date, amount, reason, notes) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [member_id, month, withdrawal_date, amount, reason || null, notes || null]
    );

    // Add transaction record
    const totalPaid = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM monthly_payments WHERE member_id = $1 AND status = $2',
      [member_id, 'PAID']
    );

    const totalWithdrawn = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE member_id = $1',
      [member_id]
    );

    const balance = parseFloat(totalPaid.rows[0].total) - parseFloat(totalWithdrawn.rows[0].total);

    await pool.query(
      `INSERT INTO transactions 
       (member_id, transaction_date, month, transaction_type, amount, description, balance_after) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [member_id, withdrawal_date, month, 'WITHDRAWAL', amount, `Withdrawal - ${reason || 'No reason specified'}`, balance]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating withdrawal:', error);
    res.status(500).json({ error: 'Failed to create withdrawal' });
  }
});

// Update withdrawal
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, reason, notes } = req.body;

    const result = await pool.query(
      `UPDATE withdrawals 
       SET amount = $1, reason = $2, notes = $3, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $4 RETURNING *`,
      [amount, reason, notes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating withdrawal:', error);
    res.status(500).json({ error: 'Failed to update withdrawal' });
  }
});

// Delete withdrawal
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get withdrawal details
    const withdrawalResult = await pool.query(
      'SELECT member_id, withdrawal_date FROM withdrawals WHERE id = $1',
      [id]
    );

    const result = await pool.query(
      'DELETE FROM withdrawals WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    // Delete associated transaction
    if (withdrawalResult.rows.length > 0) {
      await pool.query(
        'DELETE FROM transactions WHERE member_id = $1 AND transaction_date = $2 AND transaction_type = $3',
        [withdrawalResult.rows[0].member_id, withdrawalResult.rows[0].withdrawal_date, 'WITHDRAWAL']
      );
    }

    res.json({ message: 'Withdrawal deleted successfully' });
  } catch (error) {
    console.error('Error deleting withdrawal:', error);
    res.status(500).json({ error: 'Failed to delete withdrawal' });
  }
});

module.exports = router;
