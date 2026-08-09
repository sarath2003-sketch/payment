const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// GET /api/notifications — Member's own notifications
// ============================================================
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (req.admin?.type === 'admin') {
      // Admins see broadcast (null member_id) notifications
      const result = await pool.query(`
        SELECT * FROM notifications
        WHERE member_id IS NULL
        ORDER BY created_at DESC
        LIMIT 50
      `);
      return res.json({ notifications: result.rows, unread_count: 0 });
    }

    const memberId = req.admin.id;
    const result = await pool.query(`
      SELECT * FROM notifications
      WHERE member_id = $1 OR member_id IS NULL
      ORDER BY created_at DESC
      LIMIT 50
    `, [memberId]);

    const unreadCount = result.rows.filter(n => !n.is_read).length;
    res.json({ notifications: result.rows, unread_count: unreadCount });
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// ============================================================
// PUT /api/notifications/:id/read — Mark single notification read
// ============================================================
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
    await pool.query(`
      UPDATE notifications SET is_read = TRUE WHERE id = $1 AND (member_id = $2 OR member_id IS NULL)
    `, [req.params.id, req.admin?.type === 'member' ? req.admin.id : null]);
    res.json({ message: 'Marked as read' });
  } catch (err) {
    console.error('Error marking notification read:', err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ============================================================
// PUT /api/notifications/read-all — Mark all read for member
// ============================================================
router.put('/read-all', authenticateToken, async (req, res) => {
  try {
    if (req.admin?.type !== 'member') return res.status(403).json({ error: 'Members only' });
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE (member_id = $1 OR member_id IS NULL) AND is_read = FALSE`,
      [req.admin.id]
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Error marking all read:', err);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

// ============================================================
// GET /api/notifications/unread-count — Quick unread count
// ============================================================
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    if (req.admin?.type !== 'member') return res.json({ count: 0 });
    const result = await pool.query(`
      SELECT COUNT(*) AS count FROM notifications
      WHERE (member_id = $1 OR member_id IS NULL) AND is_read = FALSE
    `, [req.admin.id]);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Error getting unread count:', err);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

module.exports = router;
