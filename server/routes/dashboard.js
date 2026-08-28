
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get dashboard summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    // Total members
    const membersResult = await pool.query("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active FROM members WHERE deleted_at IS NULL");
    const totalMembers = parseInt(membersResult.rows[0]?.total || 0, 10);
    const activeMembers = parseInt(membersResult.rows[0]?.active || 0, 10);

    // Total collected
    const collectedResult = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM payment_proofs WHERE status = 'APPROVED'"
    );
    const totalCollected = parseFloat(collectedResult.rows[0]?.total || 0);

    // Total monthly_payments collected
    const monthlyPaidRes = await pool.query(
      "SELECT COALESCE(SUM(amount_paid), 0) as total FROM monthly_payments WHERE status = 'PAID' OR amount_paid > 0"
    );
    const totalMonthlyPaid = parseFloat(monthlyPaidRes.rows[0]?.total || 0);
    const grandTotalCollected = Math.max(totalCollected, totalMonthlyPaid);

    // Seed Fund & Loans summary
    const seedRes = await pool.query(`
      SELECT 
        COALESCE(SUM(principal_amount), 0) as total_distributed,
        COALESCE(SUM(interest_amount), 0) as total_interest_earned,
        COALESCE(SUM(total_payable), 0) as total_payable,
        COALESCE(SUM(total_repaid), 0) as total_repaid,
        COALESCE(SUM(remaining_amount), 0) as pending_repayments
      FROM seed_fund_distributions
    `);

    const seedRow = seedRes.rows[0] || {};
    const totalDistributed = parseFloat(seedRow.total_distributed || 0);
    const totalInterestEarned = parseFloat(seedRow.total_interest_earned || 0);
    const totalRepaid = parseFloat(seedRow.total_repaid || 0);
    const pendingRepayments = parseFloat(seedRow.pending_repayments || 0);

    // Overdue repayments
    const today = new Date().toISOString().split('T')[0];
    const overdueRes = await pool.query(`
      SELECT COALESCE(SUM(remaining_amount), 0) as total 
      FROM seed_fund_distributions 
      WHERE remaining_amount > 0 AND due_date < $1
    `, [today]);
    const overdueRepayments = parseFloat(overdueRes.rows[0]?.total || 0);

    // Total withdrawn
    const withdrawnResult = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals'
    );
    const totalWithdrawn = parseFloat(withdrawnResult.rows[0]?.total || 0);

    // Current Available Fund Balance: Total Collections + Repayments - Distributed - Withdrawn
    const availableBalance = Math.max(0, Math.round((grandTotalCollected + totalRepaid - totalDistributed - totalWithdrawn) * 100) / 100);

    // Current month income vs outgoing
    const currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM
    const incomeRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM transactions 
      WHERE (transaction_type = 'MEMBER_CONTRIBUTION' OR transaction_type = 'REPAYMENT' OR transaction_type = 'PAYMENT')
        AND strftime('%Y-%m', transaction_date) = $1
    `, [currentMonth]);
    const monthlyIncome = parseFloat(incomeRes.rows[0]?.total || 0);

    const outgoingRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM transactions 
      WHERE (transaction_type = 'FUND_DISTRIBUTION' OR transaction_type = 'WITHDRAWAL')
        AND strftime('%Y-%m', transaction_date) = $1
    `, [currentMonth]);
    const monthlyOutgoing = parseFloat(outgoingRes.rows[0]?.total || 0);

    // Members who paid this month
    const paidThisMonthRes = await pool.query(`
      SELECT COUNT(DISTINCT member_id) as total FROM payment_proofs 
      WHERE status = 'APPROVED' AND (strftime('%Y-%m', payment_date) = $1 OR strftime('%Y-%m', created_at) = $1)
    `, [currentMonth]);
    const paidThisMonth = parseInt(paidThisMonthRes.rows[0]?.total || 0, 10);
    const pendingMembersCount = Math.max(0, activeMembers - paidThisMonth);

    // Recent transactions
    const recentResult = await pool.query(
      'SELECT t.*, m.name as member_name, m.member_id as member_code FROM transactions t JOIN members m ON t.member_id = m.id ORDER BY t.created_at DESC LIMIT 10'
    );

    res.json({
      total_members: totalMembers,
      active_members: activeMembers,
      paid_this_month: paidThisMonth,
      pending_members: pendingMembersCount,
      total_collected: grandTotalCollected,
      total_distributed: totalDistributed,
      total_interest_earned: totalInterestEarned,
      total_repayments: totalRepaid,
      pending_repayments: pendingRepayments,
      overdue_repayments: overdueRepayments,
      current_balance: availableBalance,
      available_balance: availableBalance,
      monthly_income: monthlyIncome,
      monthly_outgoing: monthlyOutgoing,
      net_balance: availableBalance,
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
