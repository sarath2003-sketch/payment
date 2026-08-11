const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET ALL SEED FUND DISTRIBUTIONS
 * GET /api/seed-fund/distributions
 */
router.get('/distributions', authenticateToken, async (req, res) => {
  try {
    let sql = `
      SELECT d.*, m.name as member_name, m.member_id as member_code, m.phone as member_phone, g.group_name
      FROM seed_fund_distributions d
      JOIN members m ON d.member_id = m.id
      LEFT JOIN groups g ON d.group_id = g.id
    `;
    let params = [];

    // If member logged in, restrict to own distributions
    if (req.admin && req.admin.type === 'member') {
      sql += ` WHERE d.member_id = $1`;
      params.push(req.admin.id);
    }

    sql += ` ORDER BY d.id DESC`;

    const result = await pool.query(sql, params);
    res.json({ distributions: result.rows });
  } catch (err) {
    console.error('Error fetching distributions:', err);
    res.status(500).json({ error: 'Failed to fetch seed fund distributions' });
  }
});

/**
 * CREATE A NEW SEED FUND DISTRIBUTION (LOAN-LIKE RECORD)
 * POST /api/seed-fund/distributions
 */
router.post('/distributions', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    let {
      group_id,
      member_id,
      principal_amount,
      interest_percentage = 5.0,
      distribution_date,
      due_date,
      nominee_name,
      notes
    } = req.body || {};

    principal_amount = parseFloat(principal_amount);
    interest_percentage = parseFloat(interest_percentage);

    if (!member_id || isNaN(principal_amount) || principal_amount <= 0) {
      return res.status(400).json({ error: 'Valid member and positive principal amount are required.' });
    }

    if (isNaN(interest_percentage) || interest_percentage < 0) {
      return res.status(400).json({ error: 'Valid non-negative interest percentage is required.' });
    }

    // Calculations: Interest = Principal * (Interest % / 100)
    const interest_amount = Math.round((principal_amount * (interest_percentage / 100)) * 100) / 100;
    const total_payable = Math.round((principal_amount + interest_amount) * 100) / 100;
    const remaining_amount = total_payable;

    const distDate = distribution_date || new Date().toISOString().split('T')[0];
    
    // Default due date to 30 days if omitted
    let defaultDueDate = new Date();
    defaultDueDate.setDate(defaultDueDate.getDate() + 30);
    const dueDate = due_date || defaultDueDate.toISOString().split('T')[0];

    // Auto-fetch nominee if not provided
    if (!nominee_name) {
      const nomineeRes = await pool.query('SELECT nominee_name FROM nominees WHERE member_id = $1 ORDER BY id DESC LIMIT 1', [member_id]);
      if (nomineeRes.rows.length > 0) {
        nominee_name = nomineeRes.rows[0].nominee_name;
      }
    }

    await client.query('BEGIN');

    const result = await client.query(`
      INSERT INTO seed_fund_distributions (
        group_id, member_id, principal_amount, interest_percentage, interest_amount,
        total_payable, total_repaid, remaining_amount, distribution_date, due_date,
        nominee_name, payment_status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, 0.00, $7, $8, $9, $10, 'PENDING', $11)
      RETURNING *
    `, [
      group_id || null,
      member_id,
      principal_amount,
      interest_percentage,
      interest_amount,
      total_payable,
      remaining_amount,
      distDate,
      dueDate,
      nominee_name || null,
      notes || null
    ]);

    const distribution = result.rows[0];

    // Record transaction in ledger
    const monthStr = distDate.substring(0, 7);
    await client.query(`
      INSERT INTO transactions (
        member_id, transaction_date, month, transaction_type, amount, description, reference_type, reference_id, status
      ) VALUES ($1, $2, $3, 'FUND_DISTRIBUTION', $4, $5, 'SEED_FUND', $6, 'COMPLETED')
    `, [
      member_id,
      distDate,
      monthStr,
      principal_amount,
      `Fund Distribution #${distribution.id} (Principal: ₹${principal_amount}, Interest: ₹${interest_amount})`,
      distribution.id
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Seed fund distribution created successfully!',
      distribution
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating distribution:', err);
    res.status(500).json({ error: 'Failed to create fund distribution' });
  } finally {
    client.release();
  }
});

/**
 * GET SUMMARY METRICS
 * GET /api/seed-fund/summary
 */
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    // Total monthly collection from monthly_payments
    const collectionRes = await pool.query(`SELECT COALESCE(SUM(amount_paid), 0) as total FROM monthly_payments WHERE status = 'PAID' OR amount_paid > 0`);
    const totalCollection = parseFloat(collectionRes.rows[0]?.total || 0);

    // Seed fund totals
    const seedRes = await pool.query(`
      SELECT 
        COALESCE(SUM(principal_amount), 0) as total_distributed,
        COALESCE(SUM(interest_amount), 0) as total_interest_earned,
        COALESCE(SUM(total_payable), 0) as total_payable,
        COALESCE(SUM(total_repaid), 0) as total_repaid,
        COALESCE(SUM(remaining_amount), 0) as total_pending_due
      FROM seed_fund_distributions
    `);

    const row = seedRes.rows[0] || {};
    const totalDistributed = parseFloat(row.total_distributed || 0);
    const totalInterestEarned = parseFloat(row.total_interest_earned || 0);
    const totalPayable = parseFloat(row.total_payable || 0);
    const totalRepaid = parseFloat(row.total_repaid || 0);
    const totalPendingDue = parseFloat(row.total_pending_due || 0);

    // Overdue count
    const today = new Date().toISOString().split('T')[0];
    const overdueRes = await pool.query(`
      SELECT COUNT(*) as count, COALESCE(SUM(remaining_amount), 0) as amount 
      FROM seed_fund_distributions 
      WHERE remaining_amount > 0 AND due_date < $1
    `, [today]);
    
    const overdueCount = parseInt(overdueRes.rows[0]?.count || 0, 10);
    const overdueAmount = parseFloat(overdueRes.rows[0]?.amount || 0);

    // Calculate Available Fund Balance:
    // Available = Total Collections + Total Repayments (Principal + Interest) - Total Distributed
    const currentAvailableFund = Math.max(0, Math.round((totalCollection + totalRepaid - totalDistributed) * 100) / 100);

    res.json({
      total_collection: totalCollection,
      total_distributed: totalDistributed,
      total_interest_earned: totalInterestEarned,
      total_payable: totalPayable,
      total_repaid: totalRepaid,
      total_pending_due: totalPendingDue,
      overdue_count: overdueCount,
      overdue_amount: overdueAmount,
      current_available_fund: currentAvailableFund
    });
  } catch (err) {
    console.error('Error fetching seed fund summary:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

module.exports = router;
