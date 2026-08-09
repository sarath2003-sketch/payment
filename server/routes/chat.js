const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// GET /api/chat/:auction_id/messages — Load chat history
// ============================================================
router.get('/:auction_id/messages', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, sender_name, sender_member_id, message, message_type, voice_url, created_at, is_deleted,
             CASE WHEN admin_id IS NOT NULL THEN 'admin' ELSE 'member' END AS sender_role
      FROM auction_chat_messages
      WHERE auction_id = $1 AND is_deleted = FALSE
      ORDER BY created_at ASC
      LIMIT 200
    `, [req.params.auction_id]);
    res.json({ messages: result.rows });
  } catch (err) {
    console.error('Error fetching chat:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ============================================================
// POST /api/chat/:auction_id/send — Send message (REST fallback)
// ============================================================
router.post('/:auction_id/send', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { message } = req.body;
    if (!message || message.trim().length === 0) return res.status(400).json({ error: 'Message cannot be empty' });
    if (message.length > 500) return res.status(400).json({ error: 'Message too long (max 500 characters)' });

    // Check if muted
    if (req.admin?.type === 'member') {
      const muteCheck = await pool.query(`
        SELECT id FROM muted_members
        WHERE auction_id = $1 AND member_id = $2 AND (muted_until IS NULL OR muted_until > CURRENT_TIMESTAMP)
      `, [req.params.auction_id, req.admin.id]);
      if (muteCheck.rows.length > 0) return res.status(403).json({ error: 'You have been muted in this auction' });
    }

    let senderName, senderMemberId, memberId = null, adminId = null;
    if (req.admin?.type === 'admin') {
      adminId = req.admin.id;
      senderName = 'Admin';
      senderMemberId = 'ADMIN';
    } else {
      memberId = req.admin.id;
      const member = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
      senderName = member.rows[0]?.name || 'Member';
      senderMemberId = member.rows[0]?.member_id || '';
    }

    const result = await pool.query(`
      INSERT INTO auction_chat_messages (auction_id, member_id, admin_id, sender_name, sender_member_id, message, message_type)
      VALUES ($1, $2, $3, $4, $5, $6, 'text') RETURNING *
    `, [req.params.auction_id, memberId, adminId, senderName, senderMemberId, message.trim()]);

    const msgData = {
      id: result.rows[0].id,
      sender_name: senderName,
      sender_member_id: senderMemberId,
      message: message.trim(),
      message_type: 'text',
      created_at: result.rows[0].created_at,
      sender_role: adminId ? 'admin' : 'member'
    };

    if (io) {
      io.to(`auction_${req.params.auction_id}`).emit('auction:new-chat', msgData);
    }

    res.json({ message: 'Sent', chat: msgData });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============================================================
// DELETE /api/chat/:message_id — Admin: delete message
// ============================================================
router.delete('/:message_id', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');
  try {
    const result = await pool.query(
      'UPDATE auction_chat_messages SET is_deleted = TRUE WHERE id = $1 RETURNING auction_id',
      [req.params.message_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    if (io) {
      io.to(`auction_${result.rows[0].auction_id}`).emit('auction:message-deleted', { message_id: parseInt(req.params.message_id) });
    }
    res.json({ message: 'Message deleted' });
  } catch (err) {
    console.error('Error deleting message:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ============================================================
// POST /api/chat/:auction_id/mute/:member_id — Admin: mute member
// ============================================================
router.post('/:auction_id/mute/:member_id', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { duration_minutes, reason } = req.body;
    const mutedUntil = duration_minutes
      ? new Date(Date.now() + parseInt(duration_minutes) * 60 * 1000)
      : null;
    await pool.query(`
      INSERT INTO muted_members (auction_id, member_id, muted_by, muted_until, reason)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (auction_id, member_id) DO UPDATE SET muted_until = $4, reason = $5, muted_by = $3
    `, [req.params.auction_id, req.params.member_id, req.admin.id, mutedUntil, reason || 'Muted by admin']);
    if (io) {
      io.to(`auction_${req.params.auction_id}`).emit('auction:member-muted', {
        member_id: parseInt(req.params.member_id),
        muted_until: mutedUntil
      });
    }
    res.json({ message: 'Member muted' });
  } catch (err) {
    console.error('Error muting member:', err);
    res.status(500).json({ error: 'Failed to mute member' });
  }
});

// ============================================================
// POST /api/chat/:auction_id/unmute/:member_id — Admin: unmute
// ============================================================
router.post('/:auction_id/unmute/:member_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM muted_members WHERE auction_id = $1 AND member_id = $2',
      [req.params.auction_id, req.params.member_id]
    );
    res.json({ message: 'Member unmuted' });
  } catch (err) {
    console.error('Error unmuting member:', err);
    res.status(500).json({ error: 'Failed to unmute member' });
  }
});

// ============================================================
// POST /api/chat/:auction_id/voice — Upload voice message
// ============================================================
router.post('/:auction_id/voice', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    if (!req.files || !req.files.voice) {
      return res.status(400).json({ error: 'No voice file uploaded' });
    }
    const voiceFile = req.files.voice;
    const allowedTypes = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/mp4'];
    if (!allowedTypes.includes(voiceFile.mimetype)) {
      return res.status(400).json({ error: 'Invalid audio format' });
    }
    if (voiceFile.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Voice message too large (max 5MB)' });
    }

    const fs = require('fs');
    const path = require('path');
    const voiceDir = path.join(process.env.UPLOAD_DIR || './uploads', 'voice');
    if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

    const fileName = `voice_${req.admin.id}_${Date.now()}.webm`;
    const filePath = path.join(voiceDir, fileName);
    await voiceFile.mv(filePath);

    const voiceUrl = `/uploads/voice/${fileName}`;
    let senderName, senderMemberId, memberId = null, adminId = null;
    if (req.admin?.type === 'admin') {
      adminId = req.admin.id;
      senderName = 'Admin';
      senderMemberId = 'ADMIN';
    } else {
      memberId = req.admin.id;
      const member = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
      senderName = member.rows[0]?.name || 'Member';
      senderMemberId = member.rows[0]?.member_id || '';
    }

    // Save to DB
    await pool.query(`
      INSERT INTO voice_messages (auction_id, member_id, file_path, file_name)
      VALUES ($1, $2, $3, $4)
    `, [req.params.auction_id, memberId || adminId, filePath, fileName]);

    const result = await pool.query(`
      INSERT INTO auction_chat_messages (auction_id, member_id, admin_id, sender_name, sender_member_id, message, message_type, voice_url)
      VALUES ($1, $2, $3, $4, $5, '🎤 Voice Message', 'voice', $6) RETURNING *
    `, [req.params.auction_id, memberId, adminId, senderName, senderMemberId, voiceUrl]);

    const msgData = {
      id: result.rows[0].id,
      sender_name: senderName,
      sender_member_id: senderMemberId,
      message: '🎤 Voice Message',
      message_type: 'voice',
      voice_url: voiceUrl,
      created_at: result.rows[0].created_at,
      sender_role: adminId ? 'admin' : 'member'
    };

    if (io) {
      io.to(`auction_${req.params.auction_id}`).emit('auction:new-chat', msgData);
    }

    res.json({ message: 'Voice message sent', voice_url: voiceUrl, chat: msgData });
  } catch (err) {
    console.error('Error uploading voice:', err);
    res.status(500).json({ error: 'Failed to send voice message' });
  }
});

module.exports = router;
