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
        COALESCE(SUM(CASE WHEN t.transaction_type IN ('CREDIT','PAYMENT') THEN t.amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN t.transaction_type IN ('DEBIT','WITHDRAWAL') THEN t.amount ELSE 0 END), 0) as total_withdrawn,
        COALESCE(SUM(CASE WHEN t.transaction_type IN ('CREDIT','PAYMENT') THEN t.amount ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN t.transaction_type IN ('DEBIT','WITHDRAWAL') THEN t.amount ELSE 0 END), 0) as current_balance
      FROM members m
      LEFT JOIN transactions t ON m.id = t.member_id
      WHERE m.id = $1 OR m.member_id = $1
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

// GET /api/transactions/ledger/:memberId — Member Credit/Debit Ledger & History
router.get('/ledger/:memberId', authenticateToken, async (req, res) => {
  try {
    const { memberId } = req.params;

    // Fetch member details
    const memberRes = await pool.query(`
      SELECT id, member_id AS member_code, name, phone, email, profile_photo, status
      FROM members WHERE (CAST(id AS TEXT) = $1 OR member_id = $1) AND deleted_at IS NULL
    `, [String(memberId)]);

    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberRes.rows[0];

    // Fetch itemized transactions sorted newest-first
    const txRes = await pool.query(`
      SELECT 
        t.id,
        t.transaction_date,
        t.transaction_time,
        t.month,
        t.transaction_type,
        t.amount,
        t.description,
        t.seettu_cycle_id,
        t.reference_type,
        t.reference_id,
        t.status,
        s.title AS seettu_name
      FROM transactions t
      LEFT JOIN seettu_cycles s ON t.seettu_cycle_id = s.id
      WHERE t.member_id = $1
      ORDER BY t.transaction_date DESC, t.id DESC
    `, [member.id]);

    let totalCredit = 0;
    let totalDebit = 0;

    txRes.rows.forEach(tx => {
      const amt = parseFloat(tx.amount || 0);
      if (['CREDIT', 'PAYMENT'].includes(tx.transaction_type)) {
        totalCredit += amt;
      } else if (['DEBIT', 'WITHDRAWAL'].includes(tx.transaction_type)) {
        totalDebit += amt;
      }
    });

    const balance = totalCredit - totalDebit;

    res.json({
      member: {
        id: member.id,
        member_code: member.member_code,
        name: member.name,
        phone: member.phone,
        email: member.email,
        profile_photo: member.profile_photo,
        status: member.status
      },
      summary: {
        total_credit: totalCredit,
        total_debit: totalDebit,
        balance: balance
      },
      history: txRes.rows
    });
  } catch (error) {
    console.error('Error fetching member ledger:', error);
    res.status(500).json({ error: 'Failed to fetch member ledger' });
  }
});

// GET /api/transactions/monthly-history/:memberId — Historical Monthly Records
router.get('/monthly-history/:memberId', authenticateToken, async (req, res) => {
  try {
    const { memberId } = req.params;
    const memRes = await pool.query(`
      SELECT id, member_id AS member_code, name FROM members WHERE (CAST(id AS TEXT) = $1 OR member_id = $1) AND deleted_at IS NULL
    `, [String(memberId)]);

    if (memRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }

    const member = memRes.rows[0];

    // Fetch payments & activity amounts grouped by month
    const result = await pool.query(`
      SELECT 
        COALESCE(p.payment_month, TO_CHAR(t.transaction_date, 'YYYY-MM')) AS month,
        COALESCE(SUM(CASE WHEN t.transaction_type = 'DEBIT' THEN t.amount END), 0) AS activity_amount,
        COALESCE(SUM(CASE WHEN p.status = 'APPROVED' THEN p.amount END), 0) AS payment_amount,
        MAX(p.created_at) AS payment_date,
        COALESCE(MAX(p.status), 'PAID') AS status
      FROM members m
      LEFT JOIN transactions t ON m.id = t.member_id
      LEFT JOIN payment_proofs p ON m.id = p.member_id
      WHERE m.id = $1
      GROUP BY month
      ORDER BY month DESC
    `, [member.id]);

    res.json({
      success: true,
      member: member,
      history: result.rows.map(r => ({
        month: r.month || 'Current',
        activity_amount: parseFloat(r.activity_amount || 0),
        payment_amount: parseFloat(r.payment_amount || 0),
        payment_date: r.payment_date ? new Date(r.payment_date).toISOString().split('T')[0] : '—',
        status: r.status || 'PAID'
      }))
    });
  } catch (error) {
    console.error('Error fetching monthly history:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch monthly history' });
  }
});

// GET /api/transactions/public-profile/:memberId — Permitted Public Financial Profile
router.get('/public-profile/:memberId', authenticateToken, async (req, res) => {
  try {
    const { memberId } = req.params;

    const memberRes = await pool.query(`
      SELECT id, member_id AS member_code, name, phone, upi_id, profile_photo, created_at, activation_status, payment_status, group_category
      FROM members WHERE (CAST(id AS TEXT) = $1 OR member_id = $1) AND deleted_at IS NULL
    `, [String(memberId)]);

    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberRes.rows[0];

    // Ledger summary
    const txRes = await pool.query(`
      SELECT transaction_type, amount, transaction_date, transaction_time, description, reference_type
      FROM transactions WHERE member_id = $1
      ORDER BY transaction_date DESC, id DESC
    `, [member.id]);

    let totalCredit = 0;
    let totalDebit = 0;

    const publicHistory = txRes.rows.map(tx => {
      const amt = parseFloat(tx.amount || 0);
      if (['CREDIT', 'PAYMENT'].includes(tx.transaction_type)) totalCredit += amt;
      if (['DEBIT', 'WITHDRAWAL'].includes(tx.transaction_type)) totalDebit += amt;
      return {
        transaction_date: tx.transaction_date,
        transaction_time: tx.transaction_time || '12:00:00',
        type: tx.transaction_type,
        amount: amt,
        description: tx.description,
        reference_type: tx.reference_type
      };
    });

    // Auction wins summary
    const auctionRes = await pool.query(`
      SELECT id, title, final_amount, ended_at
      FROM auctions WHERE winner_id = $1 AND status = 'ENDED'
      ORDER BY ended_at DESC
    `, [member.id]);

    res.json({
      profile: {
        id: member.id,
        member_code: member.member_code,
        name: member.name,
        phone: member.phone,
        upi_id: member.upi_id,
        profile_photo: member.profile_photo,
        joined_at: member.created_at,
        activation_status: member.activation_status,
        payment_status: member.payment_status,
        group_category: member.group_category
      },
      financial_summary: {
        total_credit: totalCredit,
        total_debit: totalDebit,
        balance: totalCredit - totalDebit
      },
      auction_wins: auctionRes.rows,
      public_history: publicHistory
    });
  } catch (error) {
    console.error('Error fetching public profile:', error);
    res.status(500).json({ error: 'Failed to fetch public profile' });
  }
});

// POST /api/transactions/ledger — Add new transaction record
router.post('/ledger', authenticateToken, async (req, res) => {
  try {
    const {
      member_id,
      transaction_date = new Date().toISOString().split('T')[0],
      transaction_time = new Date().toTimeString().split(' ')[0],
      transaction_type,
      amount,
      description,
      seettu_cycle_id,
      reference_type = 'MANUAL',
      reference_id
    } = req.body;

    if (!member_id || !transaction_type || !amount) {
      return res.status(400).json({ error: 'member_id, transaction_type (CREDIT/DEBIT), and amount are required' });
    }

    const amt = parseFloat(amount);
    const month = transaction_date.substring(0, 7);

    const result = await pool.query(`
      INSERT INTO transactions (
        member_id, transaction_date, transaction_time, month,
        transaction_type, amount, description, seettu_cycle_id,
        reference_type, reference_id, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'COMPLETED')
      RETURNING *
    `, [member_id, transaction_date, transaction_time, month, transaction_type.toUpperCase(), amt, description || null, seettu_cycle_id || null, reference_type, reference_id || null]);

    // Financial Audit Log
    await pool.query(`
      INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, 'CREATE_TRANSACTION', 'transaction', $4, $5)
    `, [
      req.admin ? 'admin' : 'member',
      req.admin ? req.admin.id : req.user ? req.user.id : 0,
      req.admin ? 'Admin' : req.user ? req.user.name : 'System',
      result.rows[0].id,
      `${transaction_type.toUpperCase()} ₹${amt} for Member #${member_id}: ${description || ''}`
    ]);

    res.status(201).json({ message: 'Transaction created successfully', transaction: result.rows[0] });
  } catch (error) {
    console.error('Error creating transaction:', error);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

module.exports = router;
