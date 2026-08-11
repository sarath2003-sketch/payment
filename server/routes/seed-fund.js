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
 * CREATE A NEW SEED FUND DISTRIBUTION (LOAN-LIKE RECORD WITH PAYMENT SCHEDULE)
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
      monthly_amount,
      number_of_months = 12,
      distribution_date,
      start_date,
      due_date,
      nominee_name,
      notes
    } = req.body || {};

    principal_amount = parseFloat(principal_amount);
    interest_percentage = parseFloat(interest_percentage);
    number_of_months = parseInt(number_of_months, 10) || 12;

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

    // Monthly payment calculation
    let calculatedMonthly = monthly_amount ? parseFloat(monthly_amount) : Math.round((total_payable / number_of_months) * 100) / 100;

    const distDate = distribution_date || new Date().toISOString().split('T')[0];
    const sDate = start_date || distDate;
    
    // Default next payment due date (1 month after start_date if omitted)
    let startDateObj = new Date(sDate);
    if (isNaN(startDateObj.getTime())) startDateObj = new Date();
    
    const nextPayObj = new Date(startDateObj);
    nextPayObj.setMonth(nextPayObj.getMonth() + 1);
    const nextPaymentDate = due_date || nextPayObj.toISOString().split('T')[0];

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
        total_payable, total_repaid, remaining_amount, monthly_amount, number_of_months,
        distribution_date, start_date, due_date, next_payment_date, nominee_name, payment_status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, 0.00, $7, $8, $9, $10, $11, $12, $13, $14, 'PENDING', $15)
      RETURNING *
    `, [
      group_id || null,
      member_id,
      principal_amount,
      interest_percentage,
      interest_amount,
      total_payable,
      remaining_amount,
      calculatedMonthly,
      number_of_months,
      distDate,
      sDate,
      nextPaymentDate,
      nextPaymentDate,
      nominee_name || null,
      notes || null
    ]);

    const distribution = result.rows[0];

    // Generate N month-by-month payment schedules
    const schedules = [];
    let curDueDate = new Date(nextPaymentDate);

    for (let i = 1; i <= number_of_months; i++) {
      const dueDateStr = curDueDate.toISOString().split('T')[0];
      const schedRes = await client.query(`
        INSERT INTO payment_schedules (
          distribution_id, member_id, schedule_number, due_date, amount_due, amount_paid, status
        ) VALUES ($1, $2, $3, $4, $5, 0.00, 'PENDING')
        RETURNING *
      `, [distribution.id, member_id, i, dueDateStr, calculatedMonthly]);

      schedules.push(schedRes.rows[0]);

      // Increment date by 1 month for next schedule row
      curDueDate.setMonth(curDueDate.getMonth() + 1);
    }

    // Auto-create initial notice on Notice Board for member
    const memRes = await client.query('SELECT name, member_id FROM members WHERE id = $1', [member_id]);
    const memberName = memRes.rows.length > 0 ? memRes.rows[0].name : 'Member';
    const memberCode = memRes.rows.length > 0 ? memRes.rows[0].member_id : member_id;

    await client.query(`
      INSERT INTO notice_board (
        title, description, target_type, target_id, amount_due, due_date, notice_date, status, created_by
      ) VALUES ($1, $2, 'MEMBER', $3, $4, $5, $6, 'PUBLISHED', $7)
    `, [
      `Upcoming Payment Notice — ${memberName} (${memberCode})`,
      `Payment of ₹${calculatedMonthly} is due on ${nextPaymentDate} for Seed Fund Loan #${distribution.id}.`,
      member_id,
      calculatedMonthly,
      nextPaymentDate,
      distDate,
      req.admin.id
    ]);

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
      `Fund Distribution #${distribution.id} (${number_of_months} Months @ ${interest_percentage}%, Monthly: ₹${calculatedMonthly})`,
      distribution.id
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Seed fund distribution and payment schedule created successfully!',
      distribution,
      schedules
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
