const express = require('express');
const xlsx = require('xlsx');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Import Excel file
router.post('/import', authenticateToken, async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.files.file;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';

    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Read Excel file
    const workbook = xlsx.read(file.data, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(worksheet);

    let importedRecords = 0;
    const errors = [];

    // Process each row
    for (const row of data) {
      try {
        // Extract data from Excel row
        const name = row.NAME || row.name;
        const amount = row.AMOUNT || row.amount;
        const date = row.DATE || row.date;
        const status = row.SATATUS || row.STATUS || row.status || 'PAID';
        const paymentMode = row['PAYMENT MODE'] || row.payment_method || 'UPI';
        const debit = row.DEBIT || row.debit;

        if (!name) continue;

        // Check if member exists, if not create
        let memberResult = await pool.query(
          'SELECT id FROM members WHERE name = $1',
          [name]
        );

        let memberId;
        if (memberResult.rows.length === 0) {
          // Create new member
          const memberCode = name.toUpperCase().substring(0, 3) + Date.now();
          memberResult = await pool.query(
            'INSERT INTO members (member_id, name) VALUES ($1, $2) RETURNING id',
            [memberCode, name]
          );
        }

        memberId = memberResult.rows[0].id;

        // Convert Excel date serial to actual date
        let paymentDate = new Date();
        if (date && !isNaN(date)) {
          // Excel serial date
          const excelDate = parseInt(date);
          paymentDate = new Date((excelDate - 25569) * 86400 * 1000);
        }

        const monthStr = paymentDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });

        // Create payment record if amount exists
        if (amount && !isNaN(amount)) {
          await pool.query(
            `INSERT INTO monthly_payments 
             (member_id, month, payment_date, amount, status, payment_method) 
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [memberId, monthStr, paymentDate.toISOString().split('T')[0], parseFloat(amount), status, paymentMode]
          );

          // Create transaction
          await pool.query(
            `INSERT INTO transactions 
             (member_id, transaction_date, month, transaction_type, amount, description) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [memberId, paymentDate.toISOString().split('T')[0], monthStr, 'PAYMENT', parseFloat(amount), `Payment for ${monthStr}`]
          );
        }

        // Create withdrawal record if debit exists
        if (debit && !isNaN(debit)) {
          await pool.query(
            `INSERT INTO withdrawals 
             (member_id, month, withdrawal_date, amount, reason) 
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [memberId, monthStr, paymentDate.toISOString().split('T')[0], parseFloat(debit), 'From import']
          );

          // Create transaction
          await pool.query(
            `INSERT INTO transactions 
             (member_id, transaction_date, month, transaction_type, amount, description) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [memberId, paymentDate.toISOString().split('T')[0], monthStr, 'WITHDRAWAL', parseFloat(debit), 'Withdrawal']
          );
        }

        importedRecords++;
      } catch (rowError) {
        console.error('Error processing row:', rowError);
        errors.push(`Error processing row: ${rowError.message}`);
      }
    }

    // Log import
    await pool.query(
      'INSERT INTO import_history (filename, imported_records, status) VALUES ($1, $2, $3)',
      [file.name, importedRecords, 'SUCCESS']
    );

    res.json({
      message: 'Import successful',
      imported_records: importedRecords,
      errors: errors.length > 0 ? errors : null
    });
  } catch (error) {
    console.error('Error importing file:', error);
    res.status(500).json({ error: 'Failed to import file' });
  }
});

// Export members to Excel
router.get('/export/members', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        m.member_id as "Member ID",
        m.name as "Name",
        m.email as "Email",
        m.phone as "Phone",
        m.status as "Status",
        COALESCE(SUM(CASE WHEN mp.status = 'PAID' THEN mp.amount ELSE 0 END), 0) as "Total Paid",
        COALESCE(SUM(w.amount), 0) as "Total Withdrawn",
        COALESCE(SUM(CASE WHEN mp.status = 'PAID' THEN mp.amount ELSE 0 END), 0) - 
        COALESCE(SUM(w.amount), 0) as "Balance"
      FROM members m
      LEFT JOIN monthly_payments mp ON m.id = mp.member_id
      LEFT JOIN withdrawals w ON m.id = w.member_id
      GROUP BY m.id
      ORDER BY m.name
    `);

    const worksheet = xlsx.utils.json_to_sheet(result.rows);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Members');

    const filename = `members_${new Date().toISOString().split('T')[0]}.xlsx`;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const filepath = path.join(uploadDir, filename);

    xlsx.writeFile(workbook, filepath);

    res.download(filepath, filename, (err) => {
      if (err) console.error('Download error:', err);
      fs.unlink(filepath, (err) => {
        if (err) console.error('File deletion error:', err);
      });
    });
  } catch (error) {
    console.error('Error exporting members:', error);
    res.status(500).json({ error: 'Failed to export members' });
  }
});

// Export payments to Excel
router.get('/export/payments', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        m.member_id as "Member ID",
        m.name as "Member Name",
        mp.month as "Month",
        mp.payment_date as "Date",
        mp.amount as "Amount",
        mp.status as "Status",
        mp.payment_method as "Method",
        mp.notes as "Notes"
      FROM monthly_payments mp
      JOIN members m ON mp.member_id = m.id
      ORDER BY mp.payment_date DESC
    `);

    const worksheet = xlsx.utils.json_to_sheet(result.rows);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Payments');

    const filename = `payments_${new Date().toISOString().split('T')[0]}.xlsx`;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const filepath = path.join(uploadDir, filename);

    xlsx.writeFile(workbook, filepath);

    res.download(filepath, filename, (err) => {
      if (err) console.error('Download error:', err);
      fs.unlink(filepath, (err) => {
        if (err) console.error('File deletion error:', err);
      });
    });
  } catch (error) {
    console.error('Error exporting payments:', error);
    res.status(500).json({ error: 'Failed to export payments' });
  }
});

// Export withdrawals to Excel
router.get('/export/withdrawals', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        m.member_id as "Member ID",
        m.name as "Member Name",
        w.month as "Month",
        w.withdrawal_date as "Date",
        w.amount as "Amount",
        w.reason as "Reason",
        w.notes as "Notes"
      FROM withdrawals w
      JOIN members m ON w.member_id = m.id
      ORDER BY w.withdrawal_date DESC
    `);

    const worksheet = xlsx.utils.json_to_sheet(result.rows);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Withdrawals');

    const filename = `withdrawals_${new Date().toISOString().split('T')[0]}.xlsx`;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const filepath = path.join(uploadDir, filename);

    xlsx.writeFile(workbook, filepath);

    res.download(filepath, filename, (err) => {
      if (err) console.error('Download error:', err);
      fs.unlink(filepath, (err) => {
        if (err) console.error('File deletion error:', err);
      });
    });
  } catch (error) {
    console.error('Error exporting withdrawals:', error);
    res.status(500).json({ error: 'Failed to export withdrawals' });
  }
});

// Export transactions to Excel
router.get('/export/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.transaction_date as "Date",
        t.month as "Month",
        m.member_id as "Member ID",
        m.name as "Member Name",
        t.transaction_type as "Type",
        t.amount as "Amount",
        t.description as "Description",
        t.balance_after as "Balance After"
      FROM transactions t
      JOIN members m ON t.member_id = m.id
      ORDER BY t.transaction_date DESC
    `);

    const worksheet = xlsx.utils.json_to_sheet(result.rows);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Transactions');

    const filename = `transactions_${new Date().toISOString().split('T')[0]}.xlsx`;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const filepath = path.join(uploadDir, filename);

    xlsx.writeFile(workbook, filepath);

    res.download(filepath, filename, (err) => {
      if (err) console.error('Download error:', err);
      fs.unlink(filepath, (err) => {
        if (err) console.error('File deletion error:', err);
      });
    });
  } catch (error) {
    console.error('Error exporting transactions:', error);
    res.status(500).json({ error: 'Failed to export transactions' });
  }
});

// Export complete report
router.get('/export/complete-report', authenticateToken, async (req, res) => {
  try {
    const workbook = xlsx.utils.book_new();

    // Members sheet
    const membersResult = await pool.query(`
      SELECT 
        m.member_id as "Member ID",
        m.name as "Name",
        COALESCE(SUM(CASE WHEN mp.status = 'PAID' THEN mp.amount ELSE 0 END), 0) as "Total Paid",
        COALESCE(SUM(w.amount), 0) as "Total Withdrawn",
        COALESCE(SUM(CASE WHEN mp.status = 'PAID' THEN mp.amount ELSE 0 END), 0) - 
        COALESCE(SUM(w.amount), 0) as "Balance"
      FROM members m
      LEFT JOIN monthly_payments mp ON m.id = mp.member_id
      LEFT JOIN withdrawals w ON m.id = w.member_id
      GROUP BY m.id
      ORDER BY m.name
    `);
    const membersSheet = xlsx.utils.json_to_sheet(membersResult.rows);
    xlsx.utils.book_append_sheet(workbook, membersSheet, 'Members');

    // Payments sheet
    const paymentsResult = await pool.query(`
      SELECT 
        m.name as "Member Name",
        mp.month as "Month",
        mp.payment_date as "Date",
        mp.amount as "Amount",
        mp.status as "Status"
      FROM monthly_payments mp
      JOIN members m ON mp.member_id = m.id
      ORDER BY mp.payment_date DESC
    `);
    const paymentsSheet = xlsx.utils.json_to_sheet(paymentsResult.rows);
    xlsx.utils.book_append_sheet(workbook, paymentsSheet, 'Payments');

    // Withdrawals sheet
    const withdrawalsResult = await pool.query(`
      SELECT 
        m.name as "Member Name",
        w.month as "Month",
        w.withdrawal_date as "Date",
        w.amount as "Amount"
      FROM withdrawals w
      JOIN members m ON w.member_id = m.id
      ORDER BY w.withdrawal_date DESC
    `);
    const withdrawalsSheet = xlsx.utils.json_to_sheet(withdrawalsResult.rows);
    xlsx.utils.book_append_sheet(workbook, withdrawalsSheet, 'Withdrawals');

    // Transactions sheet
    const transactionsResult = await pool.query(`
      SELECT 
        m.name as "Member Name",
        t.transaction_date as "Date",
        t.transaction_type as "Type",
        t.amount as "Amount",
        t.description as "Description"
      FROM transactions t
      JOIN members m ON t.member_id = m.id
      ORDER BY t.transaction_date DESC
    `);
    const transactionsSheet = xlsx.utils.json_to_sheet(transactionsResult.rows);
    xlsx.utils.book_append_sheet(workbook, transactionsSheet, 'Transactions');

    const filename = `complete_report_${new Date().toISOString().split('T')[0]}.xlsx`;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const filepath = path.join(uploadDir, filename);

    xlsx.writeFile(workbook, filepath);

    res.download(filepath, filename, (err) => {
      if (err) console.error('Download error:', err);
      fs.unlink(filepath, (err) => {
        if (err) console.error('File deletion error:', err);
      });
    });
  } catch (error) {
    console.error('Error exporting complete report:', error);
    res.status(500).json({ error: 'Failed to export report' });
  }
});

module.exports = router;
