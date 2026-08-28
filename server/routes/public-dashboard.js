const express = require('express');
const pool = require('../config/database');

const router = express.Router();

/**
 * PUBLIC FUND DASHBOARD SUMMARY API
 * GET /api/public-dashboard/summary
 * GET /api/public-fund-details/summary
 * PUBLIC ACCESS — NO AUTHENTICATION REQUIRED
 * Returns aggregated Seed Fund figures only. Strictly no personal user information.
 */
router.get(['/summary', '/'], async (req, res) => {
  try {
    // 1. Total Registered Members (Active & Total)
    const membersRes = await pool.query(
      "SELECT COUNT(*) as total_count, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_count FROM members WHERE deleted_at IS NULL"
    );
    const totalMembers = parseInt(membersRes.rows[0]?.total_count || 0, 10);
    const activeMembers = parseInt(membersRes.rows[0]?.active_count || totalMembers, 10);

    // 2. Total Payments / Contributions Received from Members
    // Monthly payments collected
    const monthlyPaidRes = await pool.query(
      "SELECT COALESCE(SUM(amount_paid), 0) as total FROM monthly_payments WHERE status = 'PAID' OR amount_paid > 0"
    );
    const totalMonthlyPaid = parseFloat(monthlyPaidRes.rows[0]?.total || 0);

    // Approved payment proofs
    const paymentProofsRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM payment_proofs WHERE status = 'APPROVED'"
    );
    const totalPaymentProofs = parseFloat(paymentProofsRes.rows[0]?.total || 0);

    // Member total contributions (take higher of monthly_payments or payment_proofs)
    const totalMemberContributions = Math.max(totalMonthlyPaid, totalPaymentProofs);

    // Loan/Distribution Repayments received from members
    const repaymentsRes = await pool.query(
      "SELECT COALESCE(SUM(payment_amount), 0) as total FROM repayments WHERE status = 'COMPLETED'"
    );
    const totalRepaymentsReceived = parseFloat(repaymentsRes.rows[0]?.total || 0);

    // Total Amount Received From Members
    const totalReceivedFromMembers = Math.round((totalMemberContributions + totalRepaymentsReceived) * 100) / 100;

    // 3. Seed Fund Distributions & Loan Statistics
    const seedRes = await pool.query(`
      SELECT 
        COALESCE(SUM(principal_amount), 0) as total_distributed,
        COALESCE(SUM(interest_amount), 0) as total_interest_earned,
        COALESCE(SUM(total_payable), 0) as total_payable,
        COALESCE(SUM(total_repaid), 0) as total_repaid,
        COALESCE(SUM(remaining_amount), 0) as amount_outside_fund,
        COUNT(*) as total_distributions_count,
        SUM(CASE WHEN remaining_amount > 0 THEN 1 ELSE 0 END) as active_distributions_count,
        SUM(CASE WHEN remaining_amount <= 0.01 THEN 1 ELSE 0 END) as completed_distributions_count
      FROM seed_fund_distributions
    `);

    const seedRow = seedRes.rows[0] || {};
    const totalDistributed = parseFloat(seedRow.total_distributed || 0);
    const totalInterestEarned = parseFloat(seedRow.total_interest_earned || 0);
    const totalPayable = parseFloat(seedRow.total_payable || 0);
    const seedTotalRepaid = parseFloat(seedRow.total_repaid || 0);
    const amountOutsideFund = parseFloat(seedRow.amount_outside_fund || 0);
    const totalDistributionsCount = parseInt(seedRow.total_distributions_count || 0, 10);
    const activeDistributionsCount = parseInt(seedRow.active_distributions_count || 0, 10);
    const completedDistributionsCount = parseInt(seedRow.completed_distributions_count || 0, 10);

    // 4. Withdrawals from fund if any
    const withdrawalsRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals"
    );
    const totalWithdrawn = parseFloat(withdrawalsRes.rows[0]?.total || 0);

    // 5. Total Amount Given to Members (Distributions + Withdrawals)
    const totalGivenToMembers = Math.round(totalDistributed * 100) / 100;

    // 6. Current Fund Balance / Available Cash Balance
    // Current Balance = Total Received - Total Distributed
    const currentBalance = Math.max(0, Math.round((totalReceivedFromMembers - totalGivenToMembers - totalWithdrawn) * 100) / 100);

    // 7. Total Fund Amount (Total Pool Value: Available Balance + Outstanding Funds Outside)
    const totalFundAmount = Math.round((currentBalance + amountOutsideFund) * 100) / 100;

    // 8. Member Count Breakdown (Received vs Not Yet Received)
    const distinctMembersReceivedRes = await pool.query(
      "SELECT COUNT(DISTINCT member_id) as count FROM seed_fund_distributions"
    );
    const membersReceivedCount = parseInt(distinctMembersReceivedRes.rows[0]?.count || 0, 10);
    const membersNotReceivedCount = Math.max(0, totalMembers - membersReceivedCount);

    // 9. Active Groups Count
    const groupsRes = await pool.query(
      "SELECT COUNT(*) as count FROM groups WHERE status = 'ACTIVE'"
    );
    const activeGroupsCount = parseInt(groupsRes.rows[0]?.count || 0, 10);

    // 10. Calculations & Ratios
    const recoveryRatePercent = totalPayable > 0 
      ? Math.min(100, Math.round((seedTotalRepaid / totalPayable) * 1000) / 10)
      : 0;

    const memberCoveragePercent = totalMembers > 0
      ? Math.min(100, Math.round((membersReceivedCount / totalMembers) * 1000) / 10)
      : 0;

    // Response object containing 100% aggregated public metrics only
    res.json({
      success: true,
      last_updated: new Date().toISOString(),
      metrics: {
        // Core 11 Requested Figures
        total_fund_amount: totalFundAmount,
        total_collected: totalReceivedFromMembers,
        total_distributed: totalGivenToMembers,
        total_available: currentBalance,
        current_balance: currentBalance,
        total_members: totalMembers,
        active_members: activeMembers,
        members_received_count: membersReceivedCount,
        members_not_received_count: membersNotReceivedCount,
        total_given_to_members: totalGivenToMembers,
        total_received_from_members: totalReceivedFromMembers,
        amount_outside_fund: amountOutsideFund,

        // Supplementary Overall Statistics
        total_interest_earned: totalInterestEarned,
        total_payable: totalPayable,
        total_repaid: seedTotalRepaid,
        total_withdrawn: totalWithdrawn,
        total_distributions_count: totalDistributionsCount,
        active_distributions_count: activeDistributionsCount,
        completed_distributions_count: completedDistributionsCount,
        active_groups_count: activeGroupsCount,
        recovery_rate_percent: recoveryRatePercent,
        member_coverage_percent: memberCoveragePercent
      }
    });

  } catch (error) {
    console.error('Public Dashboard API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve public fund metrics'
    });
  }
});

module.exports = router;
