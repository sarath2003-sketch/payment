const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * GET NOMINEE FOR MEMBER
 * GET /api/nominees/member/:memberId
 */
router.get('/member/:memberId', authenticateToken, async (req, res) => {
  try {
    const { memberId } = req.params;
    const result = await pool.query('SELECT * FROM nominees WHERE member_id = $1 ORDER BY id DESC LIMIT 1', [memberId]);
    res.json({ nominee: result.rows[0] || null });
  } catch (err) {
    console.error('Error fetching nominee:', err);
    res.status(500).json({ error: 'Failed to fetch nominee' });
  }
});

/**
 * SAVE OR UPDATE NOMINEE
 * POST /api/nominees
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    let { member_id, nominee_name, relationship, contact_phone, address } = req.body || {};

    // Security check: normal members can only update their own nominee
    if (req.admin && req.admin.type === 'member') {
      member_id = req.admin.id;
    }

    nominee_name = (nominee_name || '').trim();
    relationship = (relationship || '').trim();

    if (!member_id || !nominee_name || !relationship) {
      return res.status(400).json({ error: 'Member ID, Nominee Name, and Relationship are required.' });
    }

    // Check if nominee record already exists
    const existing = await pool.query('SELECT id FROM nominees WHERE member_id = $1', [member_id]);

    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(`
        UPDATE nominees 
        SET nominee_name = $1, relationship = $2, contact_phone = $3, address = $4, updated_at = CURRENT_TIMESTAMP
        WHERE member_id = $5
        RETURNING *
      `, [nominee_name, relationship, contact_phone || null, address || null, member_id]);
    } else {
      result = await pool.query(`
        INSERT INTO nominees (member_id, nominee_name, relationship, contact_phone, address)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [member_id, nominee_name, relationship, contact_phone || null, address || null]);
    }

    res.json({ message: 'Nominee information saved successfully!', nominee: result.rows[0] });
  } catch (err) {
    console.error('Error saving nominee:', err);
    res.status(500).json({ error: 'Failed to save nominee' });
  }
});

module.exports = router;
