const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Middleware: Members only
router.use(authenticateToken, (req, res, next) => {
  if (req.admin?.type === 'admin') {
    return res.status(403).json({ error: 'Members only' });
  }
  next();
});

/**
 * GET /api/chat-groups
 * List all active chat groups with member counts and current user's membership status
 */
router.get('/', async (req, res) => {
  try {
    const memberId = req.admin.id;

    const result = await pool.query(`
      SELECT 
        g.id,
        g.group_name,
        g.created_by,
        g.group_admin_id,
        g.max_members,
        g.status,
        g.created_at,
        m.name AS owner_name,
        m.member_id AS owner_member_id,
        (SELECT COUNT(*) FROM chat_group_members cgm WHERE cgm.group_id = g.id) AS member_count,
        (SELECT role FROM chat_group_members cgm WHERE cgm.group_id = g.id AND cgm.member_id = $1 LIMIT 1) AS user_role
      FROM chat_groups g
      LEFT JOIN members m ON g.group_admin_id = m.id
      WHERE g.status IN ('ACTIVE', 'FULL')
      ORDER BY g.created_at DESC
    `, [memberId]);

    // Also get user's pending group requests
    const userRequests = await pool.query(`
      SELECT id, group_name, status, created_at
      FROM chat_group_requests
      WHERE requested_by = $1
      ORDER BY created_at DESC
    `, [memberId]);

    res.json({
      groups: result.rows.map(r => ({
        ...r,
        member_count: parseInt(r.member_count || 0),
        max_members: parseInt(r.max_members || 12),
        is_member: !!r.user_role,
        is_owner: parseInt(r.group_admin_id) === memberId
      })),
      pending_requests: userRequests.rows
    });
  } catch (err) {
    console.error('Error fetching chat groups:', err);
    res.status(500).json({ error: 'Failed to fetch chat groups' });
  }
});

/**
 * POST /api/chat-groups/request
 * Submit request for a new chat group (PENDING Main Admin approval)
 */
router.post('/request', async (req, res) => {
  try {
    const memberId = req.admin.id;
    const { group_name, max_members } = req.body || {};

    if (!group_name || !group_name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const cleanName = group_name.trim();
    if (cleanName.length > 50) {
      return res.status(400).json({ error: 'Group name must be 50 characters or less' });
    }

    const capMax = Math.min(Math.max(parseInt(max_members || 12), 2), 12);

    // Create pending request
    const reqResult = await pool.query(`
      INSERT INTO chat_group_requests (group_name, requested_by, status)
      VALUES ($1, $2, 'PENDING')
      RETURNING id, group_name, status, created_at
    `, [cleanName, memberId]);

    res.status(201).json({
      message: 'Group request submitted! Waiting for Admin approval.',
      request: reqResult.rows[0]
    });
  } catch (err) {
    console.error('Error submitting group request:', err);
    res.status(500).json({ error: 'Failed to submit group request' });
  }
});

/**
 * GET /api/chat-groups/:id
 * Get detailed chat group info, members list, and 12 speaker slots
 */
router.get('/:id', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const memberId = req.admin.id;

    const groupRes = await pool.query(`
      SELECT 
        g.id, g.group_name, g.created_by, g.group_admin_id, g.max_members, g.status, g.created_at,
        m.name AS owner_name, m.member_id AS owner_member_id
      FROM chat_groups g
      LEFT JOIN members m ON g.group_admin_id = m.id
      WHERE g.id = $1
    `, [groupId]);

    if (groupRes.rows.length === 0) {
      return res.status(404).json({ error: 'Chat group not found' });
    }

    const group = groupRes.rows[0];

    // Fetch members in group
    const membersRes = await pool.query(`
      SELECT 
        cgm.id AS membership_id, cgm.role, cgm.is_muted, cgm.is_online, cgm.joined_at,
        m.id AS member_id_pk, m.member_id, m.name, m.email, m.phone
      FROM chat_group_members cgm
      JOIN members m ON cgm.member_id = m.id
      WHERE cgm.group_id = $1
      ORDER BY (CASE WHEN cgm.role = 'ADMIN' THEN 0 ELSE 1 END), cgm.joined_at ASC
    `, [groupId]);

    const activeMembers = membersRes.rows;
    const isMember = activeMembers.some(m => m.member_id_pk === memberId);
    const isOwner = group.group_admin_id === memberId;
    const userRole = activeMembers.find(m => m.member_id_pk === memberId)?.role || null;
    const userMuted = activeMembers.find(m => m.member_id_pk === memberId)?.is_muted || false;

    // Build 12 Speaker Slots
    const maxSlots = 12;
    const speakerSlots = [];

    for (let i = 0; i < maxSlots; i++) {
      if (i < activeMembers.length) {
        const mem = activeMembers[i];
        speakerSlots.push({
          slot_number: i + 1,
          is_empty: false,
          member_id_pk: mem.member_id_pk,
          member_id: mem.member_id,
          name: mem.name,
          role: mem.role,
          is_muted: !!mem.is_muted,
          is_online: !!mem.is_online,
          is_owner: mem.member_id_pk === group.group_admin_id
        });
      } else {
        speakerSlots.push({
          slot_number: i + 1,
          is_empty: true
        });
      }
    }

    res.json({
      group: {
        ...group,
        max_members: 12,
        member_count: activeMembers.length,
        is_member: isMember,
        is_owner: isOwner,
        user_role: userRole,
        user_muted: userMuted
      },
      speaker_slots: speakerSlots,
      members: activeMembers
    });
  } catch (err) {
    console.error('Error fetching chat group details:', err);
    res.status(500).json({ error: 'Failed to fetch group details' });
  }
});

/**
 * POST /api/chat-groups/:id/join
 * Join chat room (Enforces max 12 member limit)
 */
router.post('/:id/join', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const memberId = req.admin.id;

    // Check group status & member count
    const groupRes = await pool.query('SELECT id, group_name, status, max_members FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Chat group not found' });
    const group = groupRes.rows[0];

    if (group.status !== 'ACTIVE' && group.status !== 'FULL') {
      return res.status(400).json({ error: 'This chat room is not active for joining' });
    }

    // Check existing membership
    const existCheck = await pool.query('SELECT id FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);
    if (existCheck.rows.length > 0) {
      return res.json({ message: 'Already a member of this chat room' });
    }

    // Count active members
    const countRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1', [groupId]);
    const currentCount = parseInt(countRes.rows[0].count || 0);

    if (currentCount >= 12) {
      // Update status to FULL if not already
      await pool.query("UPDATE chat_groups SET status = 'FULL' WHERE id = $1", [groupId]);
      return res.status(400).json({ error: 'Room is full (Maximum 12 members reached)' });
    }

    // Add member
    await pool.query(`
      INSERT INTO chat_group_members (group_id, member_id, role, is_muted, is_online)
      VALUES ($1, $2, 'MEMBER', FALSE, TRUE)
    `, [groupId, memberId]);

    // Update member count & room status
    const newCount = currentCount + 1;
    if (newCount >= 12) {
      await pool.query("UPDATE chat_groups SET status = 'FULL' WHERE id = $1", [groupId]);
    }

    // Fetch joining member details
    const mRes = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
    const memberObj = mRes.rows[0];

    // Emit Socket event
    if (io) {
      io.to(`group_${groupId}`).emit('group:member-joined', {
        group_id: groupId,
        member_id_pk: memberId,
        member_id: memberObj?.member_id,
        name: memberObj?.name,
        member_count: newCount
      });
    }

    res.json({ message: 'Joined chat room successfully!', member_count: newCount });
  } catch (err) {
    console.error('Error joining group:', err);
    res.status(500).json({ error: 'Failed to join chat room' });
  }
});

/**
 * POST /api/chat-groups/:id/leave
 * Leave chat room (Owner must transfer ownership before leaving)
 */
router.post('/:id/leave', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const memberId = req.admin.id;

    const groupRes = await pool.query('SELECT id, group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Chat group not found' });
    const group = groupRes.rows[0];

    // Check count of other members
    const countRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1 AND member_id != $2', [groupId, memberId]);
    const otherCount = parseInt(countRes.rows[0].count || 0);

    // If Group Admin tries to leave and other members exist, require transferring ownership
    if (group.group_admin_id === memberId && otherCount > 0) {
      return res.status(400).json({ error: 'As Group Owner, please transfer ownership to another member before leaving.' });
    }

    // Delete membership
    await pool.query('DELETE FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);

    // Update group status back to ACTIVE if it was FULL
    const newCountRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1', [groupId]);
    const newCount = parseInt(newCountRes.rows[0].count || 0);
    if (newCount < 12) {
      await pool.query("UPDATE chat_groups SET status = 'ACTIVE' WHERE id = $1", [groupId]);
    }

    // If 0 members remaining, deactivate group
    if (newCount === 0) {
      await pool.query("UPDATE chat_groups SET status = 'INACTIVE' WHERE id = $1", [groupId]);
    }

    const mRes = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
    const memberObj = mRes.rows[0];

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-left', {
        group_id: groupId,
        member_id_pk: memberId,
        member_id: memberObj?.member_id,
        name: memberObj?.name,
        member_count: newCount
      });
    }

    res.json({ message: 'Left chat room successfully' });
  } catch (err) {
    console.error('Error leaving group:', err);
    res.status(500).json({ error: 'Failed to leave chat room' });
  }
});

/**
 * GET /api/chat-groups/:id/messages
 * Fetch chat message history
 */
router.get('/:id/messages', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const result = await pool.query(`
      SELECT cgm.id, cgm.group_id, cgm.member_id, cgm.sender_name, cgm.sender_member_id, 
             cgm.message_type, cgm.message, cgm.media_url, cgm.created_at
      FROM chat_group_messages cgm
      WHERE cgm.group_id = $1
      ORDER BY cgm.created_at ASC
      LIMIT 200
    `, [groupId]);

    res.json({ messages: result.rows });
  } catch (err) {
    console.error('Error fetching group messages:', err);
    res.status(500).json({ error: 'Failed to fetch group messages' });
  }
});

/**
 * POST /api/chat-groups/:id/messages
 * Send text or image message
 */
router.post('/:id/messages', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const memberId = req.admin.id;

    // Check membership & mute status
    const memCheck = await pool.query('SELECT is_muted FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);
    if (memCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not a member of this chat room' });
    }
    if (memCheck.rows[0].is_muted) {
      return res.status(403).json({ error: 'You have been muted by the Group Admin' });
    }

    let messageType = 'text';
    let messageText = (req.body.message || '').trim();
    let mediaUrl = null;

    // Handle photo attachment upload
    if (req.files && req.files.image) {
      const file = req.files.image;
      const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
      const ext = path.extname(file.name).toLowerCase();
      if (!allowedExts.includes(ext)) {
        return res.status(400).json({ error: 'Invalid image format. Allowed: JPG, PNG, WEBP, GIF' });
      }
      if (file.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image size exceeds 5MB limit' });
      }

      const uploadsDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const fileName = `chat_${groupId}_${Date.now()}${ext}`;
      const filePath = path.join(uploadsDir, fileName);

      await file.mv(filePath);
      mediaUrl = `/uploads/${fileName}`;
      messageType = 'image';
      if (!messageText) messageText = '📷 Photo';
    }

    if (!messageText && !mediaUrl) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const mRes = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
    const senderName = mRes.rows[0]?.name || 'Member';
    const senderMemberId = mRes.rows[0]?.member_id || '';

    const insRes = await pool.query(`
      INSERT INTO chat_group_messages (group_id, member_id, sender_name, sender_member_id, message_type, message, media_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [groupId, memberId, senderName, senderMemberId, messageType, messageText, mediaUrl]);

    const msgData = insRes.rows[0];

    if (io) {
      io.to(`group_${groupId}`).emit('group:new-message', msgData);
    }

    res.json({ message: 'Sent', chat: msgData });
  } catch (err) {
    console.error('Error sending group message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * POST /api/chat-groups/:id/mute (Self or Group Admin)
 */
router.post('/:id/mute', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const actorId = req.admin.id;
    const targetMemberId = parseInt(req.body.target_member_id || actorId);

    const groupRes = await pool.query('SELECT group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    const isGroupAdmin = groupRes.rows[0].group_admin_id === actorId;

    if (targetMemberId !== actorId && !isGroupAdmin) {
      return res.status(403).json({ error: 'Only Group Owner can mute other members' });
    }

    await pool.query('UPDATE chat_group_members SET is_muted = TRUE WHERE group_id = $1 AND member_id = $2', [groupId, targetMemberId]);

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-muted', { group_id: groupId, member_id_pk: targetMemberId });
    }

    res.json({ message: 'Member muted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mute member' });
  }
});

/**
 * POST /api/chat-groups/:id/unmute (Self or Group Admin)
 */
router.post('/:id/unmute', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const actorId = req.admin.id;
    const targetMemberId = parseInt(req.body.target_member_id || actorId);

    const groupRes = await pool.query('SELECT group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    const isGroupAdmin = groupRes.rows[0].group_admin_id === actorId;

    if (targetMemberId !== actorId && !isGroupAdmin) {
      return res.status(403).json({ error: 'Only Group Owner can unmute other members' });
    }

    await pool.query('UPDATE chat_group_members SET is_muted = FALSE WHERE group_id = $1 AND member_id = $2', [groupId, targetMemberId]);

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-unmuted', { group_id: groupId, member_id_pk: targetMemberId });
    }

    res.json({ message: 'Member unmuted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unmute member' });
  }
});

/**
 * POST /api/chat-groups/:id/remove-member (Group Admin only)
 */
router.post('/:id/remove-member', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const actorId = req.admin.id;
    const targetMemberId = parseInt(req.body.target_member_id);

    if (!targetMemberId) return res.status(400).json({ error: 'target_member_id is required' });

    const groupRes = await pool.query('SELECT group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    if (groupRes.rows[0].group_admin_id !== actorId) {
      return res.status(403).json({ error: 'Only Group Owner can remove members' });
    }

    await pool.query('DELETE FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, targetMemberId]);

    // Update status to ACTIVE if it was FULL
    const countRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1', [groupId]);
    const newCount = parseInt(countRes.rows[0].count || 0);
    if (newCount < 12) {
      await pool.query("UPDATE chat_groups SET status = 'ACTIVE' WHERE id = $1", [groupId]);
    }

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-removed', { group_id: groupId, member_id_pk: targetMemberId, member_count: newCount });
    }

    res.json({ message: 'Member removed from group' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * POST /api/chat-groups/:id/transfer-admin (Group Admin only)
 */
router.post('/:id/transfer-admin', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const actorId = req.admin.id;
    const newAdminId = parseInt(req.body.new_admin_id);

    if (!newAdminId) return res.status(400).json({ error: 'new_admin_id is required' });

    const groupRes = await pool.query('SELECT group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    if (groupRes.rows[0].group_admin_id !== actorId) {
      return res.status(403).json({ error: 'Only current Group Owner can transfer admin role' });
    }

    // Verify new admin is in group
    const memCheck = await pool.query('SELECT id FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, newAdminId]);
    if (memCheck.rows.length === 0) {
      return res.status(400).json({ error: 'New owner must be a member of this chat room' });
    }

    // Update roles
    await pool.query("UPDATE chat_group_members SET role = 'MEMBER' WHERE group_id = $1 AND member_id = $2", [groupId, actorId]);
    await pool.query("UPDATE chat_group_members SET role = 'ADMIN' WHERE group_id = $1 AND member_id = $2", [groupId, newAdminId]);
    await pool.query('UPDATE chat_groups SET group_admin_id = $1 WHERE id = $2', [newAdminId, groupId]);

    const newOwnerRes = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [newAdminId]);
    const newOwner = newOwnerRes.rows[0];

    if (io) {
      io.to(`group_${groupId}`).emit('group:admin-transferred', {
        group_id: groupId,
        old_admin_id: actorId,
        new_admin_id: newAdminId,
        new_admin_name: newOwner?.name,
        new_admin_member_id: newOwner?.member_id
      });
    }

    res.json({ message: 'Group admin ownership transferred successfully', new_admin: newOwner });
  } catch (err) {
    res.status(500).json({ error: 'Failed to transfer group admin' });
  }
});

module.exports = router;
