const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Middleware: Main Admin only
router.use(authenticateToken, requireAdmin);

/**
 * GET /api/admin/chat-groups
 * List all chat groups for Main Admin
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        g.id, g.group_name, g.created_by, g.group_admin_id, g.max_members, g.status, g.created_at,
        m.name AS owner_name, m.member_id AS owner_member_id, m.phone AS owner_phone,
        (SELECT COUNT(*) FROM chat_group_members cgm WHERE cgm.group_id = g.id) AS member_count
      FROM chat_groups g
      LEFT JOIN members m ON g.group_admin_id = m.id
      ORDER BY g.created_at DESC
    `);

    res.json({
      groups: result.rows.map(r => ({
        ...r,
        member_count: parseInt(r.member_count || 0),
        max_members: parseInt(r.max_members || 12)
      }))
    });
  } catch (err) {
    console.error('Error fetching admin chat groups:', err);
    res.status(500).json({ error: 'Failed to fetch chat groups' });
  }
});
/**
 * POST /api/admin/chat-groups/create
 * Main Admin directly creates an active chat room
 */
router.post('/create', async (req, res) => {
  const io = req.app.get('io');
  let client;
  try {
    const { group_name, max_members, owner_member_id } = req.body || {};
    if (!group_name || !group_name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Find owner member if specified, otherwise pick first active member or admin
    let ownerId = null;
    if (owner_member_id) {
      const ownerRes = await client.query('SELECT id FROM members WHERE member_id = $1 OR phone = $1 OR id = $2', [owner_member_id, parseInt(owner_member_id) || 0]);
      if (ownerRes.rows.length > 0) ownerId = ownerRes.rows[0].id;
    }

    if (!ownerId) {
      const firstMember = await client.query('SELECT id FROM members WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1');
      if (firstMember.rows.length > 0) ownerId = firstMember.rows[0].id;
    }

    const groupRes = await client.query(`
      INSERT INTO chat_groups (group_name, created_by, group_admin_id, max_members, status)
      VALUES ($1, $2, $3, $4, 'ACTIVE')
      RETURNING id, group_name, created_by, group_admin_id, max_members, status, created_at
    `, [group_name.trim(), ownerId || 1, ownerId || 1, max_members || 12]);

    const newGroup = groupRes.rows[0];

    if (ownerId) {
      await client.query(`
        INSERT INTO chat_group_members (group_id, member_id, role, is_speaker, is_muted, is_online)
        VALUES ($1, $2, 'ADMIN', 1, 0, 1)
        ON CONFLICT (group_id, member_id) DO NOTHING
      `, [newGroup.id, ownerId]);
    }

    await client.query('COMMIT');

    if (io) io.emit('group:created', { group: newGroup });

    res.status(201).json({ message: 'Chat room created successfully!', group: newGroup });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error creating admin chat group:', err);
    res.status(500).json({ error: err.message || 'Failed to create chat group' });
  } finally {
    if (client) client.release();
  }
});

/**
 * GET /api/admin/chat-groups/requests
 * List pending chat group requests
 */
router.get('/requests', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        req.id, req.group_name, req.requested_by, req.status, req.created_at,
        m.name AS requester_name, m.member_id AS requester_member_id, m.phone AS requester_phone
      FROM chat_group_requests req
      JOIN members m ON req.requested_by = m.id
      ORDER BY req.created_at DESC
    `);

    res.json({ requests: result.rows });
  } catch (err) {
    console.error('Error fetching pending group requests:', err);
    res.status(500).json({ error: 'Failed to fetch group requests' });
  }
});

/**
 * POST /api/admin/chat-groups/requests/:id/approve
 * Main Admin approves a group request -> Creates active chat_groups record & sets requester as Group Owner
 */
router.post('/requests/:id/approve', async (req, res) => {
  const io = req.app.get('io');
  let client;
  try {
    const requestId = parseInt(req.params.id);
    const adminId = req.admin.id;

    client = await pool.connect();
    await client.query('BEGIN');

    const reqRes = await client.query('SELECT * FROM chat_group_requests WHERE id = $1', [requestId]);
    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Group request not found' });
    }

    const groupReq = reqRes.rows[0];
    if (groupReq.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Request already ${groupReq.status.toLowerCase()}` });
    }

    // Update request status
    await client.query(`
      UPDATE chat_group_requests
      SET status = 'APPROVED', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [adminId, requestId]);

    // Create active chat group
    const grpRes = await client.query(`
      INSERT INTO chat_groups (group_name, created_by, group_admin_id, max_members, status)
      VALUES ($1, $2, $2, 12, 'ACTIVE')
      RETURNING *
    `, [groupReq.group_name, groupReq.requested_by]);

    const newGroup = grpRes.rows[0];

    // Add requester as Group Admin member — fix booleans for SQLite (0/1 not TRUE/FALSE)
    await client.query(`
      INSERT INTO chat_group_members (group_id, member_id, role, is_speaker, is_muted, is_online)
      VALUES ($1, $2, 'ADMIN', 1, 0, 1)
      ON CONFLICT (group_id, member_id) DO NOTHING
    `, [newGroup.id, groupReq.requested_by]);

    await client.query('COMMIT');

    // Create in-app notification for the requester
    try {
      await pool.query(`
        INSERT INTO notifications (member_id, title, body, type, reference_type, reference_id)
        VALUES ($1, $2, $3, 'chat_group', 'chat_group', $4)
      `, [
        groupReq.requested_by,
        '✅ Chat Room Approved!',
        `Your chat room "${groupReq.group_name}" has been approved and is now live!`,
        newGroup.id
      ]);
    } catch (notifErr) {
      // Non-fatal: log but don't block the response
      console.warn('Notification insert warning:', notifErr.message);
    }

    // Socket notification — broadcast to all members so room list updates immediately
    if (io) {
      io.emit('group:request-approved', { group: newGroup, request_id: requestId });
      io.emit('group:list-updated', { action: 'approved', group: newGroup });
    }

    res.json({ message: 'Group request approved! Group is now live.', group: newGroup });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error approving group request:', err);
    res.status(500).json({ error: 'Failed to approve group request' });
  } finally {
    if (client) client.release();
  }
});

/**
 * POST /api/admin/chat-groups/requests/:id/reject
 * Main Admin rejects a group request
 */
router.post('/requests/:id/reject', async (req, res) => {
  try {
    const requestId = parseInt(req.params.id);
    const adminId = req.admin.id;

    const result = await pool.query(`
      UPDATE chat_group_requests
      SET status = 'REJECTED', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *
    `, [adminId, requestId]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Request not found' });

    res.json({ message: 'Group request rejected', request: result.rows[0] });
  } catch (err) {
    console.error('Error rejecting group request:', err);
    res.status(500).json({ error: 'Failed to reject group request' });
  }
});

/**
 * POST /api/admin/chat-groups/groups/:id/deactivate
 * Main Admin deactivates a group
 */
router.post('/groups/:id/deactivate', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);

    const result = await pool.query(`
      UPDATE chat_groups SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING *
    `, [groupId]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Group not found' });

    if (io) {
      io.to(`group_${groupId}`).emit('group:deactivated', { group_id: groupId });
    }

    res.json({ message: 'Group deactivated', group: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate group' });
  }
});

/**
 * DELETE /api/admin/chat-groups/groups/:id
 * Main Admin permanently deletes a group
 */
router.delete('/groups/:id', async (req, res) => {
  const io = req.app.get('io');
  try {
    const groupId = parseInt(req.params.id);

    const check = await pool.query('SELECT id, group_name FROM chat_groups WHERE id = $1', [groupId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Group not found' });

    await pool.query('DELETE FROM chat_groups WHERE id = $1', [groupId]);

    if (io) {
      io.to(`group_${groupId}`).emit('group:deleted', { group_id: groupId });
    }

    res.json({ message: 'Group permanently deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

module.exports = router;
