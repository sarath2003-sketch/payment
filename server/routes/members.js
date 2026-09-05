const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all members
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, member_id, name, email, phone, status, activation_status, payment_status, is_online, last_active_at, created_at, updated_at FROM members ORDER BY name'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Get member by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, member_id, name, email, phone, status, created_at, updated_at FROM members WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching member:', error);
    res.status(500).json({ error: 'Failed to fetch member' });
  }
});

// Create member
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { member_id, name, email, phone, status } = req.body;

    if (!member_id || !name) {
      return res.status(400).json({ error: 'member_id and name are required' });
    }

    const result = await pool.query(
      'INSERT INTO members (member_id, name, email, phone, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [member_id, name, email || null, phone || null, status || 'ACTIVE']
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating member:', error);
    res.status(500).json({ error: 'Failed to create member' });
  }
});

// Update member
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, status } = req.body;
    const result = await pool.query(
      'UPDATE members SET name = $1, email = $2, phone = $3, status = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *',
      [name, email, phone, status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating member:', error);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// Profile photo upload
router.post('/profile-photo', authenticateToken, async (req, res) => {
  try {
    const memberId = req.admin?.id;
    if (!memberId) return res.status(401).json({ error: 'Authentication required' });

    let photoUrl = '';
    if (req.body && req.body.image_data) {
      const base64Data = req.body.image_data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = `avatar_${memberId}_${Date.now()}.png`;
      const uploadsDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, buffer);
      photoUrl = `/uploads/${filename}`;
    } else if (req.files && (req.files.photo || req.files.image)) {
      const file = req.files.photo || req.files.image;
      const ext = path.extname(file.name) || '.png';
      const filename = `avatar_${memberId}_${Date.now()}${ext}`;
      const uploadsDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const filePath = path.join(uploadsDir, filename);
      await file.mv(filePath);
      photoUrl = `/uploads/${filename}`;
    } else if (req.body && req.body.photo_url) {
      photoUrl = req.body.photo_url.trim();
    } else {
      return res.status(400).json({ error: 'No photo provided' });
    }

    await pool.query('UPDATE members SET profile_photo = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [photoUrl, memberId]);
    res.json({ message: 'Profile photo updated successfully', photo_url: photoUrl });
  } catch (err) {
    console.error('Error uploading profile photo:', err);
    res.status(500).json({ error: 'Failed to upload profile photo' });
  }
});

module.exports = router;