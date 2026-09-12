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
      "SELECT COUNT(*) as total_count, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_count FROM members WHERE deleted_at IS NULL AND status = 'ACTIVE'"
    );
    const totalMembers = parseInt(membersRes.rows[0]?.total_count || 0, 10);
    const activeMembers = parseInt(membersRes.rows[0]?.active_count || totalMembers, 10);

    // Fetch initial base fund pool & payment settings
    const settingsRes = await pool.query(
      "SELECT key, value FROM app_settings WHERE key IN ('initial_fund_pool', 'admin_upi_id', 'admin_upi_name', 'qr_path', 'qr_version')"
    );
    const setMap = {};
    settingsRes.rows.forEach(r => { setMap[r.key] = r.value; });
    const initialFundPool = parseFloat(setMap['initial_fund_pool'] || 0);
    const qrVersion = setMap['qr_version'] || Date.now();
    let qrPathVersioned = setMap['qr_path'] || '/assets/qr.png';
    if (setMap['qr_path'] && !setMap['qr_path'].includes('?v=')) {
      qrPathVersioned = `${setMap['qr_path']}?v=${qrVersion}`;
    }

    // 2. Total Payments / Contributions Received from Valid Active Members
    const monthlyPaidRes = await pool.query(
      "SELECT COALESCE(SUM(mp.amount_paid), 0) as total FROM monthly_payments mp JOIN members m ON mp.member_id = m.id WHERE (mp.status = 'PAID' OR mp.amount_paid > 0) AND m.deleted_at IS NULL AND m.status = 'ACTIVE'"
    );
    const totalMonthlyPaid = parseFloat(monthlyPaidRes.rows[0]?.total || 0);

    // Approved payment proofs from active members
    const paymentProofsRes = await pool.query(
      "SELECT COALESCE(SUM(p.amount), 0) as total FROM payment_proofs p JOIN members m ON p.member_id = m.id WHERE p.status = 'APPROVED' AND m.deleted_at IS NULL AND m.status = 'ACTIVE'"
    );
    const totalPaymentProofs = parseFloat(paymentProofsRes.rows[0]?.total || 0);

    // Member total contributions (take higher of monthly_payments or payment_proofs)
    const totalMemberContributions = Math.max(totalMonthlyPaid, totalPaymentProofs);

    // Loan/Distribution Repayments received from active members
    const repaymentsRes = await pool.query(
      "SELECT COALESCE(SUM(r.payment_amount), 0) as total FROM repayments r JOIN members m ON r.member_id = m.id WHERE r.status = 'COMPLETED' AND m.deleted_at IS NULL AND m.status = 'ACTIVE'"
    );
    const totalRepaymentsReceived = parseFloat(repaymentsRes.rows[0]?.total || 0);

    // Total Amount Received From Members
    const totalReceivedFromMembers = Math.round((totalMemberContributions + totalRepaymentsReceived) * 100) / 100;

    // 3. Seed Fund Distributions & Loan Statistics (Valid Active Members Only)
    const seedRes = await pool.query(`
      SELECT 
        COALESCE(SUM(d.principal_amount), 0) as total_distributed,
        COALESCE(SUM(d.interest_amount), 0) as total_interest_earned,
        COALESCE(SUM(d.total_payable), 0) as total_payable,
        COALESCE(SUM(d.total_repaid), 0) as total_repaid,
        COALESCE(SUM(d.remaining_amount), 0) as amount_outside_fund,
        COUNT(*) as total_distributions_count,
        SUM(CASE WHEN d.remaining_amount > 0 THEN 1 ELSE 0 END) as active_distributions_count,
        SUM(CASE WHEN d.remaining_amount <= 0.01 THEN 1 ELSE 0 END) as completed_distributions_count
      FROM seed_fund_distributions d
      JOIN members m ON d.member_id = m.id
      WHERE m.deleted_at IS NULL AND m.status = 'ACTIVE'
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

    // 4. Withdrawals from fund & Member Exit Refunds
    const withdrawalsRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals"
    );
    const totalWithdrawn = parseFloat(withdrawalsRes.rows[0]?.total || 0);

    const exitRefundsRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE reason = 'MEMBER_EXIT_REFUND'"
    );
    const totalRefundedToExited = parseFloat(exitRefundsRes.rows[0]?.total || 0);

    // 4b. Total Club Expenses
    const expensesRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM expenses"
    );
    const totalExpenses = parseFloat(expensesRes.rows[0]?.total || 0);

    // 5. Total Amount Given to Members
    const totalGivenToMembers = Math.round(totalDistributed * 100) / 100;

    // 6. Current Fund Balance / Available Cash Balance
    // Current Balance = Initial Pool + Total Received - Total Distributed - Total Withdrawn - Total Expenses
    const currentBalance = Math.max(0, Math.round((initialFundPool + totalReceivedFromMembers - totalGivenToMembers - totalWithdrawn - totalExpenses) * 100) / 100);

    // 7. Total Fund Amount (Total Pool Value: Available Balance + Outstanding Funds Outside)
    const totalFundAmount = Math.round((currentBalance + amountOutsideFund) * 100) / 100;

    // 8. Member Count Breakdown (Received vs Not Yet Received)
    const distinctMembersReceivedRes = await pool.query(`
      SELECT COUNT(DISTINCT d.member_id) as count 
      FROM seed_fund_distributions d
      JOIN members m ON d.member_id = m.id
      WHERE m.deleted_at IS NULL
    `);
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
      payment_info: {
        admin_upi_id: setMap['admin_upi_id'] || 'sarath9025@cnrb',
        admin_upi_name: setMap['admin_upi_name'] || 'Canara Bank · Sarathkumar',
        qr_path_versioned: qrPathVersioned
      },
      metrics: {
        // Core Requested Figures
        initial_fund_pool: initialFundPool,
        total_fund_amount: totalFundAmount,
        total_collected: totalReceivedFromMembers,
        total_member_contributions: totalMemberContributions,
        total_distributed: totalGivenToMembers,
        total_refunded_to_exited: totalRefundedToExited,
        total_expenses: totalExpenses,
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

/**
 * GET MONTHLY FINANCIAL STATEMENT (INFLOWS, OUTFLOWS, NET BALANCE & DETAILED RECORDS)
 * GET /api/public-dashboard/monthly-statement?month=YYYY-MM
 */
router.get('/monthly-statement', async (req, res) => {
  try {
    const currentMonth = new Date().toISOString().substring(0, 7);
    const targetMonth = req.query.month ? String(req.query.month).trim().substring(0, 7) : currentMonth;

    // 1. Fetch Inflows (Approved member payments & repayments in target month)
    const inflowsSql = `
      SELECT 
        p.id,
        p.member_id,
        p.amount,
        p.transaction_reference,
        p.payment_month,
        p.payment_date,
        p.created_at,
        p.status,
        COALESCE(m.name, 'Member #' || p.member_id) as member_name,
        COALESCE(m.member_id, '' || p.member_id) as member_code,
        COALESCE(m.phone, '—') as member_phone,
        'MONTHLY_PAYMENT' as category
      FROM payment_proofs p
      LEFT JOIN members m ON p.member_id = m.id
      WHERE (p.status = 'APPROVED' OR p.status = 'PAID')
        AND (p.payment_date LIKE $1 || '%' OR p.payment_month LIKE $1 || '%')
      ORDER BY p.payment_date DESC, p.id DESC
    `;
    const inflowsRes = await pool.query(inflowsSql, [targetMonth]);

    // Also fetch repayments in target month
    const repaymentsSql = `
      SELECT 
        r.id,
        r.distribution_id,
        r.member_id,
        r.payment_amount as amount,
        r.payment_date,
        r.payment_method,
        r.transaction_ref as transaction_reference,
        r.created_at,
        r.status,
        COALESCE(m.name, 'Member #' || r.member_id) as member_name,
        COALESCE(m.member_id, '' || r.member_id) as member_code,
        COALESCE(m.phone, '—') as member_phone,
        'LOAN_REPAYMENT' as category
      FROM repayments r
      LEFT JOIN members m ON r.member_id = m.id
      WHERE r.payment_date LIKE $1 || '%'
      ORDER BY r.payment_date DESC, r.id DESC
    `;
    const repaymentsRes = await pool.query(repaymentsSql, [targetMonth]);

    // Combine all inflows for target month
    const allInflows = [
      ...inflowsRes.rows.map(r => {
        let timeStr = '12:00:00';
        if (r.created_at) {
          const parts = String(r.created_at).split('T');
          if (parts[1]) timeStr = parts[1].substring(0, 8);
          else {
            const sp = String(r.created_at).split(' ');
            if (sp[1]) timeStr = sp[1].substring(0, 8);
          }
        }
        return {
          id: r.id,
          member_id: r.member_id,
          member_name: r.member_name,
          member_code: String(r.member_code || '').split('_exited_')[0],
          member_phone: String(r.member_phone || '').split('_exited_')[0],
          amount: parseFloat(r.amount) || 0,
          payment_date: r.payment_date,
          payment_time: timeStr,
          transaction_reference: r.transaction_reference || 'DIRECT-UPI',
          category: 'Monthly Chit Payment (சீட்டு கட்டணம்)'
        };
      }),
      ...repaymentsRes.rows.map(r => {
        let timeStr = '12:00:00';
        if (r.created_at) {
          const parts = String(r.created_at).split('T');
          if (parts[1]) timeStr = parts[1].substring(0, 8);
          else {
            const sp = String(r.created_at).split(' ');
            if (sp[1]) timeStr = sp[1].substring(0, 8);
          }
        }
        return {
          id: r.id,
          member_id: r.member_id,
          member_name: r.member_name,
          member_code: String(r.member_code || '').split('_exited_')[0],
          member_phone: String(r.member_phone || '').split('_exited_')[0],
          amount: parseFloat(r.amount) || 0,
          payment_date: r.payment_date,
          payment_time: timeStr,
          transaction_reference: r.transaction_reference || `REPAY-LOAN-#${r.distribution_id}`,
          category: `Loan Repayment (கடன் தவணை #${r.distribution_id})`
        };
      })
    ];

    allInflows.sort((a, b) => (b.payment_date + b.payment_time).localeCompare(a.payment_date + a.payment_time));

    // 2. Fetch Outflows (Loans Distributed + Exit Principal Refunds in target month)
    const outflowsSql = `
      SELECT 
        d.id,
        d.member_id,
        d.principal_amount,
        d.interest_percentage,
        d.interest_amount,
        d.total_payable,
        d.total_repaid,
        d.remaining_amount,
        d.distribution_date,
        d.due_date,
        d.nominee_name,
        d.payment_status,
        d.notes,
        COALESCE(m.name, 'Member #' || d.member_id) as member_name,
        COALESCE(m.member_id, '' || d.member_id) as member_code,
        COALESCE(m.phone, '—') as member_phone,
        'LOAN' as outflow_type
      FROM seed_fund_distributions d
      LEFT JOIN members m ON d.member_id = m.id
      WHERE d.distribution_date LIKE $1 || '%'
      ORDER BY d.distribution_date DESC, d.id DESC
    `;
    const outflowsRes = await pool.query(outflowsSql, [targetMonth]);

    // Also fetch exit refunds and other withdrawals in target month
    const withdrawalsSql = `
      SELECT 
        w.id,
        w.member_id,
        w.amount as principal_amount,
        0 as interest_percentage,
        0 as interest_amount,
        w.amount as total_payable,
        w.amount as total_repaid,
        0 as remaining_amount,
        w.withdrawal_date as distribution_date,
        w.withdrawal_date as due_date,
        'Principal Refund (அசல் திருப்பியளிப்பு)' as nominee_name,
        'REFUNDED' as payment_status,
        COALESCE(w.notes, 'Principal Refund on Member Exit') as notes,
        COALESCE(m.name, 'Exited Member #' || w.member_id) as member_name,
        COALESCE(m.member_id, '' || w.member_id) as member_code,
        COALESCE(m.phone, '—') as member_phone,
        'REFUND' as outflow_type
      FROM withdrawals w
      LEFT JOIN members m ON w.member_id = m.id
      WHERE w.withdrawal_date LIKE $1 || '%'
      ORDER BY w.withdrawal_date DESC, w.id DESC
    `;
    const withdrawalsRes = await pool.query(withdrawalsSql, [targetMonth]);

    const outflows = [
      ...outflowsRes.rows.map(d => ({
        id: `loan_${d.id}`,
        raw_id: d.id,
        outflow_type: 'LOAN',
        member_id: d.member_id,
        member_name: d.member_name,
        member_code: String(d.member_code || '').split('_exited_')[0],
        member_phone: String(d.member_phone || '').split('_exited_')[0],
        principal_amount: parseFloat(d.principal_amount) || 0,
        interest_percentage: parseFloat(d.interest_percentage) || 5,
        interest_amount: parseFloat(d.interest_amount) || 0,
        total_payable: parseFloat(d.total_payable) || 0,
        total_repaid: parseFloat(d.total_repaid) || 0,
        remaining_amount: parseFloat(d.remaining_amount) || 0,
        distribution_date: d.distribution_date,
        due_date: d.due_date,
        nominee_name: d.nominee_name || '—',
        payment_status: d.payment_status || 'PENDING',
        notes: d.notes
      })),
      ...withdrawalsRes.rows.map(w => ({
        id: `refund_${w.id}`,
        raw_id: w.id,
        outflow_type: 'REFUND',
        member_id: w.member_id,
        member_name: `${w.member_name} (விலகல் / Exited)`,
        member_code: String(w.member_code || '').split('_exited_')[0],
        member_phone: String(w.member_phone || '').split('_exited_')[0],
        principal_amount: parseFloat(w.principal_amount) || 0,
        interest_percentage: 0,
        interest_amount: 0,
        total_payable: parseFloat(w.principal_amount) || 0,
        total_repaid: parseFloat(w.principal_amount) || 0,
        remaining_amount: 0,
        distribution_date: w.distribution_date,
        due_date: w.due_date,
        nominee_name: 'Principal Refund (அசல் திருப்பியளிப்பு)',
        payment_status: 'PAID',
        notes: w.notes
      }))
    ];

    // 2b. Fetch Expenses for target month (சங்கச் செலவுகள்)
    const expensesSql = `
      SELECT id, title, category, amount, expense_date, expense_month, remarks, created_by_name, created_at
      FROM expenses
      WHERE expense_month = $1 OR expense_date LIKE $1 || '%'
      ORDER BY expense_date DESC, id DESC
    `;
    const expensesRes = await pool.query(expensesSql, [targetMonth]);
    const expensesList = (expensesRes.rows || []).map(e => ({
      id: e.id,
      title: e.title,
      category: e.category || 'General',
      amount: parseFloat(e.amount) || 0,
      expense_date: e.expense_date,
      expense_month: e.expense_month,
      remarks: e.remarks || '—',
      created_by_name: e.created_by_name || 'Admin'
    }));

    // 3. Totals
    const totalInflow = Math.round(allInflows.reduce((acc, x) => acc + x.amount, 0) * 100) / 100;
    const totalOutflow = Math.round(outflows.reduce((acc, x) => acc + x.principal_amount, 0) * 100) / 100;
    const totalExpenses = Math.round(expensesList.reduce((acc, x) => acc + x.amount, 0) * 100) / 100;
    // Net Monthly Flow = Inflows - Outflows - Expenses
    const netMonthlyFlow = Math.round((totalInflow - totalOutflow - totalExpenses) * 100) / 100;

    // Overall metrics for closing balance
    const overallColl = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payment_proofs WHERE status = 'APPROVED' OR status = 'PAID'`);
    const overallRepay = await pool.query(`SELECT COALESCE(SUM(payment_amount), 0) as total FROM repayments WHERE status = 'COMPLETED'`);
    const overallLoans = await pool.query(`SELECT COALESCE(SUM(principal_amount), 0) as total FROM seed_fund_distributions`);
    const overallWithdrawals = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals`);
    const overallExpenses = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses`);

    const poolCollection = parseFloat(overallColl.rows[0]?.total || 0) + parseFloat(overallRepay.rows[0]?.total || 0);
    const poolExpenses = parseFloat(overallExpenses.rows[0]?.total || 0);
    const poolDisbursed = parseFloat(overallLoans.rows[0]?.total || 0) + parseFloat(overallWithdrawals.rows[0]?.total || 0) + poolExpenses;
    const currentPoolBalance = Math.max(0, Math.round((poolCollection - poolDisbursed) * 100) / 100);

    // 4. Generate list of available months (including all months with database records)
    const availableMonths = [];
    const dateCursor = new Date();
    for (let i = 0; i < 6; i++) {
      const mStr = dateCursor.toISOString().substring(0, 7);
      if (!availableMonths.includes(mStr)) availableMonths.push(mStr);
      dateCursor.setMonth(dateCursor.getMonth() - 1);
    }
    if (!availableMonths.includes(targetMonth)) availableMonths.unshift(targetMonth);

    try {
      const dbMonthsRes = await pool.query(`
        SELECT DISTINCT substr(payment_date, 1, 7) as m FROM payment_proofs WHERE payment_date IS NOT NULL
        UNION
        SELECT DISTINCT substr(distribution_date, 1, 7) as m FROM seed_fund_distributions WHERE distribution_date IS NOT NULL
        UNION
        SELECT DISTINCT expense_month as m FROM expenses WHERE expense_month IS NOT NULL
      `);
      for (const row of dbMonthsRes.rows || []) {
        if (row.m && /^\d{4}-\d{2}$/.test(row.m) && !availableMonths.includes(row.m)) {
          availableMonths.push(row.m);
        }
      }
      availableMonths.sort((a, b) => b.localeCompare(a));
    } catch (e) {}

    res.json({
      success: true,
      month: targetMonth,
      available_months: availableMonths,
      summary: {
        total_inflow: totalInflow,
        total_outflow: totalOutflow,
        total_expenses: totalExpenses,
        net_monthly_flow: netMonthlyFlow,
        total_transactions_count: allInflows.length + outflows.length + expensesList.length,
        inflow_count: allInflows.length,
        outflow_count: outflows.length,
        expense_count: expensesList.length,
        current_pool_balance: currentPoolBalance
      },
      inflows: allInflows,
      outflows: outflows,
      expenses: expensesList
    });
  } catch (error) {
    console.error('Monthly Statement Error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate monthly statement: ' + error.message });
  }
});

module.exports = router;


