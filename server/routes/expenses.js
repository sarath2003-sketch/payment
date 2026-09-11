const express = require('express');
const pool = require('../config/database');
const { adminOnly } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/expenses
 * List all expenses or filter by month (?month=YYYY-MM)
 * Public or admin read
 */
router.get('/', async (req, res) => {
  try {
    const { month } = req.query;
    let queryText = 'SELECT * FROM expenses';
    let params = [];

    if (month && String(month).trim() !== '') {
      const cleanMonth = String(month).trim().substring(0, 7);
      queryText += " WHERE expense_month = $1 OR expense_date LIKE $1 || '%'";
      params.push(cleanMonth);
    }

    queryText += ' ORDER BY expense_date DESC, id DESC';

    const result = await pool.query(queryText, params);
    const expenses = (result.rows || []).map(r => ({
      ...r,
      amount: parseFloat(r.amount) || 0
    }));

    const totalAmount = Math.round(expenses.reduce((sum, item) => sum + (item.amount || 0), 0) * 100) / 100;

    // Overall all-time total expenses
    const overallRes = await pool.query('SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses');
    const totalExpenses = parseFloat(overallRes.rows[0]?.total || 0);
    const totalCount = parseInt(overallRes.rows[0]?.count || 0, 10);

    res.json({
      success: true,
      count: expenses.length,
      total_amount: totalAmount,
      month_expenses: totalAmount,
      month_count: expenses.length,
      total_expenses: totalExpenses,
      total_count: totalCount,
      expenses
    });
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch expenses: ' + error.message });
  }
});

/**
 * GET /api/expenses/summary
 * Aggregate stats: all-time total expenses and current month expenses
 */
router.get('/summary', async (req, res) => {
  try {
    const currentMonth = new Date().toISOString().substring(0, 7);

    // All time expenses
    const totalRes = await pool.query('SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses');
    const totalExpenses = parseFloat(totalRes.rows[0]?.total || 0);
    const totalCount = parseInt(totalRes.rows[0]?.count || 0, 10);

    // Current month expenses
    const monthRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses WHERE expense_month = $1 OR expense_date LIKE $1 || '%'",
      [currentMonth]
    );
    const currentMonthExpenses = parseFloat(monthRes.rows[0]?.total || 0);
    const currentMonthCount = parseInt(monthRes.rows[0]?.count || 0, 10);

    res.json({
      success: true,
      current_month: currentMonth,
      total_expenses: totalExpenses,
      total_count: totalCount,
      current_month_expenses: currentMonthExpenses,
      current_month_count: currentMonthCount
    });
  } catch (error) {
    console.error('Error fetching expenses summary:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch expenses summary: ' + error.message });
  }
});

/**
 * POST /api/expenses
 * Create a new expense entry (Admin Only)
 */
router.post('/', adminOnly, async (req, res) => {
  try {
    let { title, category, amount, expense_date, expense_month, remarks } = req.body;

    if (!title || String(title).trim() === '') {
      return res.status(400).json({ success: false, error: 'Expense title / purpose is required (செலவு விவரம் தேவை)' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid positive expense amount is required (சரியான தொகை தேவை)' });
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const finalDate = (expense_date && /^\d{4}-\d{2}-\d{2}$/.test(expense_date)) ? expense_date : todayStr;
    const finalMonth = (expense_month && /^\d{4}-\d{2}$/.test(expense_month)) ? expense_month : finalDate.substring(0, 7);
    const finalCategory = (category && String(category).trim() !== '') ? String(category).trim() : 'General';
    const finalRemarks = remarks ? String(remarks).trim() : '';

    const adminId = req.admin?.id || 1;
    const adminName = req.admin?.username || 'Admin';

    const insertSql = `
      INSERT INTO expenses (title, category, amount, expense_date, expense_month, remarks, created_by, created_by_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    const insertRes = await pool.query(insertSql, [
      String(title).trim(),
      finalCategory,
      parsedAmount,
      finalDate,
      finalMonth,
      finalRemarks,
      adminId,
      adminName
    ]);

    let createdRecord = insertRes.rows[0];
    if (!createdRecord) {
      // Fallback query if RETURNING not populated
      const fetchLatest = await pool.query('SELECT * FROM expenses ORDER BY id DESC LIMIT 1');
      createdRecord = fetchLatest.rows[0];
    }

    // Record audit log
    try {
      await pool.query(`
        INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details)
        VALUES ('ADMIN', $1, $2, 'CREATE_EXPENSE', 'EXPENSE', $3, $4)
      `, [
        adminId,
        adminName,
        createdRecord?.id || 0,
        `Expense ₹${parsedAmount} for '${title}' in ${finalMonth} recorded.`
      ]);
    } catch (auditErr) {
      console.warn('Audit log write error:', auditErr.message);
    }

    // Emit Socket.IO notification if available
    const io = req.app.get('io');
    if (io) {
      io.emit('expense:created', {
        id: createdRecord?.id,
        title,
        amount: parsedAmount,
        expense_date: finalDate,
        expense_month: finalMonth,
        remarks: finalRemarks
      });
      io.emit('dashboard:refresh');
    }

    res.status(201).json({
      success: true,
      message: `செலவு ₹${parsedAmount.toLocaleString('en-IN')} வெற்றிகரமாக சேர்க்கப்பட்டது!`,
      expense: createdRecord
    });
  } catch (error) {
    console.error('Error creating expense:', error);
    res.status(500).json({ success: false, error: 'Failed to create expense: ' + error.message });
  }
});

/**
 * PUT /api/expenses/:id
 * Update an existing expense entry (Admin Only)
 */
router.put('/:id', adminOnly, async (req, res) => {
  try {
    const expenseId = parseInt(req.params.id, 10);
    if (isNaN(expenseId) || expenseId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid expense ID' });
    }

    const { title, category, amount, expense_date, expense_month, remarks } = req.body;
    const parsedAmount = parseFloat(amount);

    const checkRes = await pool.query('SELECT * FROM expenses WHERE id = $1', [expenseId]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Expense record not found' });
    }

    const existing = checkRes.rows[0];
    const newTitle = title !== undefined ? String(title).trim() : existing.title;
    const newCategory = category !== undefined ? String(category).trim() : existing.category;
    const newAmount = !isNaN(parsedAmount) && parsedAmount > 0 ? parsedAmount : existing.amount;
    const newDate = expense_date || existing.expense_date;
    const newMonth = expense_month || (newDate ? String(newDate).substring(0, 7) : existing.expense_month);
    const newRemarks = remarks !== undefined ? String(remarks).trim() : existing.remarks;

    await pool.query(`
      UPDATE expenses 
      SET title = $1, category = $2, amount = $3, expense_date = $4, expense_month = $5, remarks = $6, updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
    `, [newTitle, newCategory, newAmount, newDate, newMonth, newRemarks, expenseId]);

    const updatedRes = await pool.query('SELECT * FROM expenses WHERE id = $1', [expenseId]);

    const io = req.app.get('io');
    if (io) {
      io.emit('dashboard:refresh');
    }

    res.json({
      success: true,
      message: 'செலவு விவரம் புதுப்பிக்கப்பட்டது',
      expense: updatedRes.rows[0]
    });
  } catch (error) {
    console.error('Error updating expense:', error);
    res.status(500).json({ success: false, error: 'Failed to update expense: ' + error.message });
  }
});

/**
 * DELETE /api/expenses/:id
 * Delete an expense entry (Admin Only)
 */
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const expenseId = parseInt(req.params.id, 10);
    if (isNaN(expenseId) || expenseId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid expense ID' });
    }

    const checkRes = await pool.query('SELECT * FROM expenses WHERE id = $1', [expenseId]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Expense record not found' });
    }

    const deletedRecord = checkRes.rows[0];
    await pool.query('DELETE FROM expenses WHERE id = $1', [expenseId]);

    // Record audit log
    const adminId = req.admin?.id || 1;
    const adminName = req.admin?.username || 'Admin';
    try {
      await pool.query(`
        INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details)
        VALUES ('ADMIN', $1, $2, 'DELETE_EXPENSE', 'EXPENSE', $3, $4)
      `, [
        adminId,
        adminName,
        expenseId,
        `Deleted expense ID ${expenseId} (₹${deletedRecord.amount} for '${deletedRecord.title}')`
      ]);
    } catch (auditErr) {
      console.warn('Audit log write error:', auditErr.message);
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('expense:deleted', { id: expenseId });
      io.emit('dashboard:refresh');
    }

    res.json({
      success: true,
      message: `செலவு பதிவு (ID: ${expenseId}) வெற்றிகரமாக நீக்கப்பட்டது.`
    });
  } catch (error) {
    console.error('Error deleting expense:', error);
    res.status(500).json({ success: false, error: 'Failed to delete expense: ' + error.message });
  }
});

module.exports = router;
