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

/**
 * PUBLIC REAL-TIME LIVE ACTIVITY & TRANSACTIONS FEED
 * GET /api/public-dashboard/live-feed
 * Shows:
 * 1. Who paid amount (e.g., ₹500 for the month, Date, Time, Member Name, Member ID, Status: PAID)
 * 2. Who took amount (Seed Fund Distributions/Loans, Date, Time, Member Name, Member ID, Status: DISTRIBUTED)
 */
router.get('/live-feed', async (req, res) => {
  try {
    // 1. Fetch recent approved payments (who paid)
    const paymentsRes = await pool.query(`
      SELECT 
        p.id,
        'PAYMENT' AS type,
        m.id AS member_db_id,
        COALESCE(m.member_id, CAST(m.id AS TEXT)) AS member_code,
        m.name AS member_name,
        m.profile_photo,
        p.amount,
        p.payment_month,
        p.payment_date,
        p.transaction_reference,
        'PAID' AS status,
        COALESCE(p.verified_at, p.created_at) AS sort_timestamp,
        p.created_at
      FROM payment_proofs p
      JOIN members m ON p.member_id = m.id
      WHERE p.status = 'APPROVED'
      ORDER BY COALESCE(p.verified_at, p.created_at) DESC
      LIMIT 60
    `);

    // 2. Fetch seed fund distributions (who received/took amount)
    const distributionsRes = await pool.query(`
      SELECT 
        d.id,
        'DISTRIBUTION' AS type,
        m.id AS member_db_id,
        COALESCE(m.member_id, CAST(m.id AS TEXT)) AS member_code,
        m.name AS member_name,
        m.profile_photo,
        d.principal_amount AS amount,
        NULL AS payment_month,
        d.distribution_date AS payment_date,
        NULL AS transaction_reference,
        'DISTRIBUTED' AS status,
        COALESCE(d.distribution_date, d.created_at) AS sort_timestamp,
        d.created_at
      FROM seed_fund_distributions d
      JOIN members m ON d.member_id = m.id
      ORDER BY d.created_at DESC
      LIMIT 40
    `);

    // Merge and standardize entries
    const items = [];

    for (const row of paymentsRes.rows) {
      const dt = new Date(row.sort_timestamp || row.created_at || Date.now());
      const dateStr = dt.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
      const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

      let monthLabel = row.payment_month || '';
      if (row.payment_month && row.payment_month.includes('-')) {
        const [yr, mo] = row.payment_month.split('-');
        const monthDate = new Date(parseInt(yr), parseInt(mo) - 1, 1);
        monthLabel = monthDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      }

      items.push({
        id: `pay_${row.id}`,
        type: 'PAYMENT',
        action: 'PAID',
        member_name: row.member_name || 'Member',
        member_code: row.member_code || '—',
        profile_photo: row.profile_photo || null,
        amount: parseFloat(row.amount || 500),
        month: row.payment_month || '',
        month_label: monthLabel,
        date: dateStr,
        time: timeStr,
        timestamp: dt.toISOString(),
        status: 'PAID',
        status_tamil: 'செலுத்தப்பட்டது (PAID)',
        title: `₹${parseFloat(row.amount || 500).toLocaleString('en-IN')} Paid${monthLabel ? ` for ${monthLabel}` : ''}`,
        title_tamil: `${monthLabel ? `${monthLabel} மாத தவணை ` : ''}₹${parseFloat(row.amount || 500).toLocaleString('en-IN')} செலுத்தப்பட்டது`
      });
    }

    for (const row of distributionsRes.rows) {
      const dt = new Date(row.sort_timestamp || row.created_at || Date.now());
      const dateStr = dt.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
      const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

      items.push({
        id: `dist_${row.id}`,
        type: 'DISTRIBUTION',
        action: 'TAKEN',
        member_name: row.member_name || 'Member',
        member_code: row.member_code || '—',
        profile_photo: row.profile_photo || null,
        amount: parseFloat(row.amount || 0),
        month: null,
        month_label: null,
        date: dateStr,
        time: timeStr,
        timestamp: dt.toISOString(),
        status: 'DISTRIBUTED',
        status_tamil: 'பெறப்பட்டது (RECEIVED)',
        title: `₹${parseFloat(row.amount || 0).toLocaleString('en-IN')} Seed Fund Loan Given`,
        title_tamil: `₹${parseFloat(row.amount || 0).toLocaleString('en-IN')} சீட்டு நிதி கடன் வழங்கப்பட்டது`
      });
    }

    // Sort combined feed by timestamp descending
    items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      success: true,
      server_time: new Date().toISOString(),
      counts: {
        total_items: items.length,
        payments_count: paymentsRes.rows.length,
        distributions_count: distributionsRes.rows.length
      },
      feed: items
    });
  } catch (error) {
    console.error('Live Feed API Error:', error);
    res.status(500).json({ success: false, error: 'Failed to load live feed' });
  }
});

/**
 * PUBLIC MEMBER TRANSPARENCY LOOKUP
 * GET /api/public-dashboard/member/:code
 * Returns public verified contribution metrics for a member.
 * Strictly no phone, password, email, or nominee data exposed.
 */
router.get('/member/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ success: false, error: 'Member code is required' });

    const memberRes = await pool.query(
      `SELECT id, member_id, name, profile_photo, status, created_at
       FROM members
       WHERE (member_id = $1 OR CAST(id AS TEXT) = $1) AND deleted_at IS NULL
       LIMIT 1`,
      [code]
    );

    if (memberRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Member not found' });
    }

    const m = memberRes.rows[0];

    // Payments summary
    const paymentsRes = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM payment_proofs
       WHERE member_id = $1 AND status = 'APPROVED'`,
      [m.id]
    );

    // Distribution summary
    const distRes = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(principal_amount), 0) as total
       FROM seed_fund_distributions
       WHERE member_id = $1`,
      [m.id]
    );

    const joinedDate = m.created_at ? new Date(m.created_at).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

    res.json({
      success: true,
      member: {
        id: m.id,
        member_code: m.member_id || `SF${String(m.id).padStart(3, '0')}`,
        name: m.name,
        profile_photo: m.profile_photo || null,
        status: m.status || 'ACTIVE',
        joined_date: joinedDate,
        payments_count: parseInt(paymentsRes.rows[0]?.count || 0, 10),
        total_paid_amount: parseFloat(paymentsRes.rows[0]?.total || 0),
        loans_count: parseInt(distRes.rows[0]?.count || 0, 10),
        total_loan_amount: parseFloat(distRes.rows[0]?.total || 0)
      }
    });
  } catch (error) {
    console.error('Public Member Lookup Error:', error);
    res.status(500).json({ success: false, error: 'Failed to look up member' });
  }
});

module.exports = router;

