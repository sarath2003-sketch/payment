const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET MEMBER-TARGETED NOTICES
 * GET /api/notices
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let memberId = req.admin ? req.admin.id : null;
    let params = [];
    let sql = `
      SELECT n.*, m.name as member_name, m.member_id as member_code
      FROM notice_board n
      LEFT JOIN members m ON n.target_id = m.id AND n.target_type = 'MEMBER'
      WHERE n.status != 'CANCELLED'
    `;

    if (req.admin && req.admin.type === 'member') {
      sql += ` AND (n.target_type = 'ALL' OR (n.target_type = 'MEMBER' AND n.target_id = $1))`;
      params.push(memberId);
    }

    sql += ` ORDER BY n.id DESC`;

    const result = await pool.query(sql, params);
    res.json({ notices: result.rows });
  } catch (err) {
    console.error('Error fetching notices:', err);
    res.status(500).json({ error: 'Failed to fetch notice board' });
  }
});

/**
 * ADMIN: GET ALL NOTICES
 * GET /api/notices/admin
 */
router.get('/admin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT n.*, m.name as member_name, m.member_id as member_code
      FROM notice_board n
      LEFT JOIN members m ON n.target_id = m.id AND n.target_type = 'MEMBER'
      ORDER BY n.id DESC
    `);
    res.json({ notices: result.rows });
  } catch (err) {
    console.error('Error fetching admin notices:', err);
    res.status(500).json({ error: 'Failed to fetch admin notice board' });
  }
});

/**
 * ADMIN: CREATE NOTICE
 * POST /api/notices
 */
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let { title, description, target_type = 'ALL', target_id, amount_due, due_date, notice_date } = req.body || {};

    title = (title || '').trim();
    description = (description || '').trim();

    if (!title || !description) {
      return res.status(400).json({ error: 'Notice title and description are required.' });
    }

    const nDate = notice_date || new Date().toISOString().split('T')[0];

    const result = await pool.query(`
      INSERT INTO notice_board (
        title, description, target_type, target_id, amount_due, due_date, notice_date, status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PUBLISHED', $8)
      RETURNING *
    `, [
      title,
      description,
      target_type,
      target_id || null,
      amount_due ? parseFloat(amount_due) : null,
      due_date || null,
      nDate,
      req.admin.id
    ]);

    res.status(201).json({
      message: 'Notice created and published successfully!',
      notice: result.rows[0]
    });
  } catch (err) {
    console.error('Error creating notice:', err);
    res.status(500).json({ error: 'Failed to create notice' });
  }
});

/**
 * ADMIN: UPDATE NOTICE
 * PUT /api/notices/:id
 */
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    let { title, description, target_type, target_id, amount_due, due_date, status } = req.body || {};

    const result = await pool.query(`
      UPDATE notice_board
      SET title = COALESCE($1, title),
          description = COALESCE($2, description),
          target_type = COALESCE($3, target_type),
          target_id = COALESCE($4, target_id),
          amount_due = COALESCE($5, amount_due),
          due_date = COALESCE($6, due_date),
          status = COALESCE($7, status),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [title, description, target_type, target_id, amount_due, due_date, status, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notice not found.' });
    }

    res.json({ message: 'Notice updated successfully', notice: result.rows[0] });
  } catch (err) {
    console.error('Error updating notice:', err);
    res.status(500).json({ error: 'Failed to update notice' });
  }
});

/**
 * ADMIN: DELETE NOTICE
 * DELETE /api/notices/:id
 */
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM notice_board WHERE id = $1', [id]);
    res.json({ message: 'Notice deleted successfully.' });
  } catch (err) {
    console.error('Error deleting notice:', err);
    res.status(500).json({ error: 'Failed to delete notice' });
  }
});

module.exports = router;
