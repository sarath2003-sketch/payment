const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Middleware: Authenticated users (Members or Admin)
router.use(authenticateToken);

/**
 * GET /api/chat-groups
 * List all active chat groups with speaker counts and total audience counts
 */
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.admin?.type === 'admin';
    const memberId = isAdmin ? 0 : req.admin.id;

    // Ensure default general discussion room exists
    const existing = await pool.query('SELECT id FROM chat_groups WHERE status IN (\'APPROVED\', \'ACTIVE\') LIMIT 1');
    if (existing.rows.length === 0) {
      try {
        await pool.query(`
          INSERT INTO chat_groups (group_name, created_by, group_admin_id, max_members, status)
          VALUES ('📢 PF Chit Fund General Discussion / பொது அரட்டை', 1, 1, 12, 'ACTIVE')
        `);
      } catch (e) {}
    }

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
        (SELECT COUNT(*) FROM chat_group_members cgm WHERE cgm.group_id = g.id) AS total_member_count,
        (SELECT COUNT(*) FROM chat_group_members cgm WHERE cgm.group_id = g.id AND (cgm.is_speaker = TRUE OR cgm.is_speaker = 1)) AS speaker_count,
        (SELECT role FROM chat_group_members cgm WHERE cgm.group_id = g.id AND cgm.member_id = $1 LIMIT 1) AS user_role
      FROM chat_groups g
      LEFT JOIN members m ON g.group_admin_id = m.id
      WHERE g.status IN ('APPROVED', 'ACTIVE', 'FULL')
      ORDER BY g.created_at DESC
    `, [memberId]);

    // User's pending requests
    let userRequests = { rows: [] };
    if (!isAdmin) {
      userRequests = await pool.query(`
        SELECT id, group_name, status, created_at
        FROM chat_group_requests
        WHERE requested_by = $1
        ORDER BY created_at DESC
      `, [memberId]);
    }

    const formattedGroups = result.rows.map(r => ({
      ...r,
      total_member_count: parseInt(r.total_member_count || 0),
      speaker_count: parseInt(r.speaker_count || 0),
      max_members: 12, // 12 Speaker Slots max
      is_member: isAdmin ? true : !!r.user_role,
      is_owner: isAdmin ? true : parseInt(r.group_admin_id) === memberId
    }));

    res.json({
      success: true,
      groups: formattedGroups,
      rooms: formattedGroups,
      pending_requests: userRequests.rows
    });
  } catch (err) {
    console.error('Error fetching chat groups:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch chat groups', message: 'Failed to fetch chat groups' });
  }
});

/**
 * POST /api/chat-groups/request
 * Submit request for a new chat group (PENDING Main Admin approval)
 */
router.post('/request', async (req, res) => {
  try {
    const memberId = req.admin.id;
    const { group_name } = req.body || {};

    if (!group_name || !group_name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const cleanName = group_name.trim();
    if (cleanName.length > 50) {
      return res.status(400).json({ error: 'Group name must be 50 characters or less' });
    }

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
 * Get detailed chat group info, 12 speaker slots, and audience member list
 */
router.get('/:id', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    const memberId = isAdmin ? 0 : req.admin.id;

    const groupRes = await pool.query(`
      SELECT 
        g.id, g.group_name, g.created_by, g.group_admin_id, g.max_members, g.status, g.created_at,
        g.ludo_active, g.ludo_state,
        m.name AS owner_name, m.member_id AS owner_member_id
      FROM chat_groups g
      LEFT JOIN members m ON g.group_admin_id = m.id
      WHERE g.id = $1
    `, [groupId]);

    if (groupRes.rows.length === 0) {
      return res.status(404).json({ error: 'Chat group not found' });
    }

    const group = groupRes.rows[0];

    // Parse ludo state safely
    let parsedLudoState = null;
    try {
      if (group.ludo_state) {
        parsedLudoState = typeof group.ludo_state === 'string' ? JSON.parse(group.ludo_state) : group.ludo_state;
      }
    } catch (e) {}

    // Fetch members in group - Strictly deduplicated by member id
    const membersRes = await pool.query(`
      SELECT 
        cgm.id AS membership_id, cgm.role, cgm.is_muted, cgm.is_speaker, cgm.is_online, cgm.joined_at,
        m.id AS member_id_pk, m.member_id, m.name, m.email, m.phone
      FROM chat_group_members cgm
      JOIN members m ON cgm.member_id = m.id
      WHERE cgm.group_id = $1 AND m.deleted_at IS NULL
      GROUP BY m.id
      ORDER BY (CASE WHEN cgm.role = 'ADMIN' THEN 0 ELSE 1 END), cgm.joined_at ASC
    `, [groupId]);

    const activeMembers = membersRes.rows;
    const currentMemberObj = activeMembers.find(m => m.member_id_pk === memberId);
    const isMember = isAdmin ? true : !!currentMemberObj;
    const isOwner = isAdmin ? true : (group.group_admin_id === memberId);
    const isSpeaker = isAdmin ? true : (currentMemberObj ? (currentMemberObj.is_speaker === true || currentMemberObj.is_speaker === 1) : false);
    const userRole = isAdmin ? 'MAIN_ADMIN' : (currentMemberObj?.role || null);
    const userMuted = isAdmin ? false : (currentMemberObj?.is_muted || false);

    // Build 12 Speaker Slots with Main Admin in Slot #1 and Room Owner as Co-Admin in Slot #2
    const speakerSlots = [];
    
    // Slot 1: Supreme Main Admin (கிளப் தலைமை / தலைவர்)
    speakerSlots.push({
      slot_number: 1,
      is_empty: false,
      member_id_pk: 0,
      member_id: 'ADMIN',
      name: '👑 Main Admin / கிளப் தலைமை',
      role: 'MAIN_ADMIN',
      is_muted: false,
      is_online: true,
      is_owner: true,
      is_supreme: true
    });

    // Slot 2: Room Creator / Co-Admin (குழு பொறுப்பாளர்)
    const coAdminMem = activeMembers.find(m => m.member_id_pk === group.group_admin_id);
    speakerSlots.push({
      slot_number: 2,
      is_empty: false,
      member_id_pk: group.group_admin_id || 1,
      member_id: group.owner_member_id || ('#' + (group.group_admin_id || 1)),
      name: (group.owner_name || 'Group Admin') + ' (துணை அட்மின்)',
      role: 'CO_ADMIN',
      is_muted: coAdminMem ? !!coAdminMem.is_muted : false,
      is_online: coAdminMem ? !!coAdminMem.is_online : true,
      is_owner: false,
      is_co_admin: true
    });

    // Remaining speakers (strictly deduplicated so no name repeats)
    const seenSpeakerIds = new Set([group.group_admin_id, 0]);
    const otherSpeakers = [];
    for (const m of activeMembers) {
      if ((m.is_speaker === true || m.is_speaker === 1) && !seenSpeakerIds.has(m.member_id_pk)) {
        seenSpeakerIds.add(m.member_id_pk);
        otherSpeakers.push(m);
      }
    }

    // Slots 3 to 12
    for (let slotNum = 3; slotNum <= 12; slotNum++) {
      const spkIdx = slotNum - 3;
      if (spkIdx < otherSpeakers.length) {
        const mem = otherSpeakers[spkIdx];
        speakerSlots.push({
          slot_number: slotNum,
          is_empty: false,
          member_id_pk: mem.member_id_pk,
          member_id: mem.member_id,
          name: mem.name,
          role: mem.role,
          is_muted: !!mem.is_muted,
          is_online: !!mem.is_online,
          is_owner: false
        });
      } else {
        speakerSlots.push({
          slot_number: slotNum,
          is_empty: true
        });
      }
    }

    const audience = activeMembers.filter(m => !(m.is_speaker === true || m.is_speaker === 1) && m.member_id_pk !== group.group_admin_id);

    res.json({
      group: {
        ...group,
        ludo_active: !!group.ludo_active,
        ludo_state: parsedLudoState,
        max_members: 12,
        total_member_count: activeMembers.length + (isAdmin ? 1 : 0),
        speaker_count: 2 + otherSpeakers.length,
        is_member: isMember,
        is_owner: isOwner,
        is_speaker: isSpeaker,
        user_role: userRole,
        user_muted: userMuted,
        is_main_admin: isAdmin
      },
      speaker_slots: speakerSlots,
      audience: audience,
      members: activeMembers
    });
  } catch (err) {
    console.error('Error fetching chat group details:', err);
    res.status(500).json({ error: 'Failed to fetch group details' });
  }
});

/**
 * POST /api/chat-groups/:id/join
 * Join chat room (Audience capacity unlimited; auto-assigns speaker slot if < 12 active speakers)
 */
router.post('/:id/join', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    const memberId = isAdmin ? 0 : req.admin.id;

    const groupRes = await pool.query('SELECT id, group_name, status FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Chat group not found' });
    const group = groupRes.rows[0];

    // Main Admin has supreme authority - always joins without restriction
    if (isAdmin) {
      if (io) {
        io.to(`group_${groupId}`).emit('group:member-joined', {
          group_id: groupId,
          member_id_pk: 0,
          member_id: 'ADMIN',
          name: '👑 Main Admin / கிளப் தலைமை',
          is_speaker: true,
          total_member_count: 1
        });
      }
      return res.json({ message: 'Supreme Admin entered chat room!', is_speaker: true, total_member_count: 1 });
    }

    const allowedJoinStatuses = ['APPROVED', 'ACTIVE', 'FULL'];
    if (!allowedJoinStatuses.includes(group.status)) {
      return res.status(400).json({ error: 'This chat room is not currently accepting members' });
    }

    // Check existing membership
    const existCheck = await pool.query('SELECT id, is_speaker FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);
    if (existCheck.rows.length > 0) {
      return res.json({ message: 'Already in this chat room' });
    }

    // Check current speaker count
    const spkCountRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1 AND (is_speaker = TRUE OR is_speaker = 1)', [groupId]);
    const currentSpeakers = parseInt(spkCountRes.rows[0].count || 0);

    // Auto-assign speaker slot if < 12 active speakers
    const assignSpeaker = currentSpeakers < 12;

    await pool.query(`
      INSERT INTO chat_group_members (group_id, member_id, role, is_muted, is_speaker, is_online)
      VALUES ($1, $2, 'MEMBER', 0, $3, 1)
    `, [groupId, memberId, assignSpeaker ? 1 : 0]);

    // Get updated total member count
    const totalCountRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1', [groupId]);
    const totalCount = parseInt(totalCountRes.rows[0].count || 0);

    const mRes = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
    const memberObj = mRes.rows[0];

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-joined', {
        group_id: groupId,
        member_id_pk: memberId,
        member_id: memberObj?.member_id,
        name: memberObj?.name,
        is_speaker: assignSpeaker,
        total_member_count: totalCount
      });
    }

    res.json({ message: 'Joined chat room successfully!', is_speaker: assignSpeaker, total_member_count: totalCount });
  } catch (err) {
    console.error('Error joining group:', err);
    res.status(500).json({ error: 'Failed to join chat room' });
  }
});

/**
 * POST /api/chat-groups/:id/take-speaker-slot
 * Occupy a speaker slot if active speakers < 12
 */
router.post('/:id/take-speaker-slot', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    if (isAdmin) {
      return res.json({ message: 'Supreme Admin stage slot occupied' });
    }
    const memberId = req.admin.id;

    // Verify membership
    const memCheck = await pool.query('SELECT id FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);
    if (memCheck.rows.length === 0) return res.status(403).json({ error: 'You are not in this chat room' });

    // Check active speakers count
    const spkCountRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1 AND (is_speaker = TRUE OR is_speaker = 1)', [groupId]);
    const currentSpeakers = parseInt(spkCountRes.rows[0].count || 0);

    if (currentSpeakers >= 12) {
      return res.status(400).json({ error: 'All 12 Speaker Slots are currently occupied.' });
    }

    await pool.query('UPDATE chat_group_members SET is_speaker = 1 WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-muted', { group_id: groupId, member_id_pk: memberId });
    }

    res.json({ message: 'Occupied speaker slot successfully!' });
  } catch (err) {
    console.error('Error taking speaker slot:', err);
    res.status(500).json({ error: 'Failed to take speaker slot' });
  }
});

/**
 * POST /api/chat-groups/:id/leave-speaker-slot
 * Step down from speaker slot to audience
 */
router.post('/:id/leave-speaker-slot', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    if (isAdmin) {
      return res.json({ message: 'Admin stepped down' });
    }
    const memberId = req.admin.id;

    await pool.query('UPDATE chat_group_members SET is_speaker = 0 WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-muted', { group_id: groupId, member_id_pk: memberId });
    }

    res.json({ message: 'Stepped down to audience' });
  } catch (err) {
    console.error('Error stepping down:', err);
    res.status(500).json({ error: 'Failed to step down' });
  }
});

/**
 * POST /api/chat-groups/:id/leave
 * Leave chat room completely
 */
router.post('/:id/leave', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    if (isAdmin) {
      return res.json({ message: 'Admin left view' });
    }
    const memberId = req.admin.id;

    const groupRes = await pool.query('SELECT id, group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Chat group not found' });
    const group = groupRes.rows[0];

    const countRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1 AND member_id != $2', [groupId, memberId]);
    const otherCount = parseInt(countRes.rows[0].count || 0);

    if (group.group_admin_id === memberId && otherCount > 0) {
      return res.status(400).json({ error: 'As Group Owner, please transfer ownership to another member before leaving.' });
    }

    await pool.query('DELETE FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);

    const newCountRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1', [groupId]);
    const newCount = parseInt(newCountRes.rows[0].count || 0);

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
        total_member_count: newCount
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
    const isAdmin = req.admin?.type === 'admin';
    let memberId = null;
    let senderName = 'Admin / தலைவர்';
    let senderMemberId = 'ADMIN';

    if (isAdmin) {
      memberId = null;
    } else {
      memberId = req.admin.id;
      const memCheck = await pool.query('SELECT is_muted FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, memberId]);
      if (memCheck.rows.length === 0) {
        // Auto-join member so they can participate immediately
        try {
          await pool.query(`
            INSERT INTO chat_group_members (group_id, member_id, role, is_speaker, is_muted)
            VALUES ($1, $2, 'AUDIENCE', 0, 0)
          `, [groupId, memberId]);
        } catch (e) {}
      } else if (memCheck.rows[0].is_muted) {
        return res.status(403).json({ error: 'You have been muted by the Group Admin' });
      }

      const mRes = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
      senderName = mRes.rows[0]?.name || 'Member';
      senderMemberId = mRes.rows[0]?.member_id || ('#' + memberId);
    }

    let messageType = 'text';
    let messageText = (req.body.message || '').trim();
    let mediaUrl = null;

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

    // AUTOMATIC DEDUPLICATION: Suppress rapid duplicate message sent within 3 seconds
    const recentDup = await pool.query(
      `SELECT id, created_at, group_id, sender_name, message, media_url, message_type, sender_member_id 
       FROM chat_group_messages 
       WHERE group_id = $1 AND sender_name = $2 AND message = $3 
       ORDER BY id DESC LIMIT 1`,
      [groupId, senderName, messageText]
    );

    if (recentDup.rows.length > 0) {
      const lastMsg = recentDup.rows[0];
      const diffMs = Date.now() - new Date(lastMsg.created_at).getTime();
      if (!isNaN(diffMs) && diffMs < 3000) {
        console.log(`[DEDUPLICATION] Duplicate message suppressed for ${senderName} in group ${groupId}`);
        return res.json({ message: 'Sent', chat: lastMsg, duplicate_suppressed: true });
      }
    }

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
    res.status(500).json({ error: 'Failed to send message: ' + err.message });
  }
});

/**
 * POST /api/chat-groups/:id/mute (Self or Group Admin or Main Admin)
 */
router.post('/:id/mute', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    const actorId = isAdmin ? 0 : req.admin.id;
    const targetMemberId = parseInt(req.body.target_member_id || actorId);

    const groupRes = await pool.query('SELECT group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    const isGroupAdmin = groupRes.rows[0].group_admin_id === actorId;

    if (!isAdmin && targetMemberId !== actorId && !isGroupAdmin) {
      return res.status(403).json({ error: 'Only Group Owner or Main Admin can mute other members' });
    }

    await pool.query('UPDATE chat_group_members SET is_muted = 1 WHERE group_id = $1 AND member_id = $2', [groupId, targetMemberId]);

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-muted', { group_id: groupId, member_id_pk: targetMemberId });
    }

    res.json({ message: 'Member muted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mute member' });
  }
});

/**
 * POST /api/chat-groups/:id/unmute (Self or Group Admin or Main Admin)
 */
router.post('/:id/unmute', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    const actorId = isAdmin ? 0 : req.admin.id;
    const targetMemberId = parseInt(req.body.target_member_id || actorId);

    const groupRes = await pool.query('SELECT group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    const isGroupAdmin = groupRes.rows[0].group_admin_id === actorId;

    if (!isAdmin && targetMemberId !== actorId && !isGroupAdmin) {
      return res.status(403).json({ error: 'Only Group Owner or Main Admin can unmute other members' });
    }

    await pool.query('UPDATE chat_group_members SET is_muted = 0 WHERE group_id = $1 AND member_id = $2', [groupId, targetMemberId]);

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-unmuted', { group_id: groupId, member_id_pk: targetMemberId });
    }

    res.json({ message: 'Member unmuted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unmute member' });
  }
});

/**
 * POST /api/chat-groups/:id/remove-member (Group Admin or Main Admin)
 */
router.post('/:id/remove-member', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    const actorId = isAdmin ? 0 : req.admin.id;
    const targetMemberId = parseInt(req.body.target_member_id);

    if (!targetMemberId) return res.status(400).json({ error: 'target_member_id is required' });

    const groupRes = await pool.query('SELECT group_admin_id FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    if (!isAdmin && groupRes.rows[0].group_admin_id !== actorId) {
      return res.status(403).json({ error: 'Only Group Owner or Main Admin can remove members' });
    }

    await pool.query('DELETE FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, targetMemberId]);

    const countRes = await pool.query('SELECT COUNT(*) FROM chat_group_members WHERE group_id = $1', [groupId]);
    const newCount = parseInt(countRes.rows[0].count || 0);

    if (io) {
      io.to(`group_${groupId}`).emit('group:member-removed', { group_id: groupId, member_id_pk: targetMemberId, total_member_count: newCount });
    }

    res.json({ message: 'Member removed from group' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * POST /api/chat-groups/:id/ludo/toggle
 * Toggle Ludo Mini-Game ON/OFF (Group Owner or Main Admin)
 */
router.post('/:id/ludo/toggle', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const isAdmin = req.admin?.type === 'admin';
    const memberId = isAdmin ? 0 : req.admin.id;

    const groupRes = await pool.query('SELECT group_admin_id, ludo_active FROM chat_groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    const isOwner = groupRes.rows[0].group_admin_id === memberId;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'Only Group Owner or Main Admin can toggle Ludo mini-game' });
    }

    const currentActive = groupRes.rows[0].ludo_active === 1 || groupRes.rows[0].ludo_active === true;
    const newActive = currentActive ? 0 : 1;

    await pool.query('UPDATE chat_groups SET ludo_active = $1 WHERE id = $2', [newActive, groupId]);

    if (io) {
      io.to(`group_${groupId}`).emit('group:ludo-toggled', { group_id: groupId, enabled: !!newActive });
    }

    res.json({ success: true, ludo_active: !!newActive });
  } catch (err) {
    console.error('Error toggling Ludo game:', err);
    res.status(500).json({ error: 'Failed to toggle Ludo game' });
  }
});

/**
 * POST /api/chat-groups/:id/ludo/action
 * Update Ludo game state (dice roll, token move, turn change)
 */
router.post('/:id/ludo/action', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);
    const { action, state, player, message } = req.body || {};

    if (state) {
      const stateStr = typeof state === 'string' ? state : JSON.stringify(state);
      await pool.query('UPDATE chat_groups SET ludo_state = $1 WHERE id = $2', [stateStr, groupId]);
    }

    if (io) {
      io.to(`group_${groupId}`).emit('group:ludo-updated', {
        group_id: groupId,
        action,
        state,
        player,
        message
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating Ludo game:', err);
    res.status(500).json({ error: 'Failed to update Ludo game' });
  }
});

/**
 * GET /api/chat-groups/:id/ludo/state
 * Fetch current Ludo game state
 */
router.get('/:id/ludo/state', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const gRes = await pool.query('SELECT ludo_active, ludo_state FROM chat_groups WHERE id = $1', [groupId]);
    if (gRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });

    let parsedState = null;
    try {
      if (gRes.rows[0].ludo_state) {
        parsedState = typeof gRes.rows[0].ludo_state === 'string' ? JSON.parse(gRes.rows[0].ludo_state) : gRes.rows[0].ludo_state;
      }
    } catch (e) {}

    res.json({
      success: true,
      ludo_active: !!gRes.rows[0].ludo_active,
      ludo_state: parsedState
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Ludo state' });
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

    const memCheck = await pool.query('SELECT id FROM chat_group_members WHERE group_id = $1 AND member_id = $2', [groupId, newAdminId]);
    if (memCheck.rows.length === 0) {
      return res.status(400).json({ error: 'New owner must be a member of this chat room' });
    }

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
