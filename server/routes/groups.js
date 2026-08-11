const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET ALL GROUPS
 * GET /api/groups
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const groupsRes = await pool.query(`
      SELECT g.*, 
        COUNT(DISTINCT gm.member_id) as current_member_count,
        COALESCE(COUNT(DISTINCT gm.member_id) * g.monthly_contribution, 0) as total_monthly_collection
      FROM groups g
      LEFT JOIN group_members gm ON g.id = gm.group_id
      GROUP BY g.id
      ORDER BY g.id DESC
    `);
    res.json({ groups: groupsRes.rows });
  } catch (err) {
    console.error('Error fetching groups:', err);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

/**
 * CREATE GROUP
 * POST /api/groups
 */
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let { group_name, monthly_contribution = 500, total_members = 20, interest_percentage = 5.0, notes } = req.body || {};

    group_name = (group_name || '').trim();
    monthly_contribution = parseFloat(monthly_contribution);
    total_members = parseInt(total_members, 10);
    interest_percentage = parseFloat(interest_percentage);

    if (!group_name) {
      return res.status(400).json({ error: 'Group name is required.' });
    }
    if (isNaN(monthly_contribution) || monthly_contribution <= 0) {
      return res.status(400).json({ error: 'Monthly contribution must be a positive number.' });
    }
    if (isNaN(total_members) || total_members <= 0) {
      return res.status(400).json({ error: 'Total members capacity must be a positive integer.' });
    }

    const result = await pool.query(`
      INSERT INTO groups (group_name, monthly_contribution, total_members, interest_percentage, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [group_name, monthly_contribution, total_members, interest_percentage, notes || null]);

    res.status(201).json({
      message: 'Group created successfully!',
      group: result.rows[0]
    });
  } catch (err) {
    console.error('Error creating group:', err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

/**
 * UPDATE GROUP
 * PUT /api/groups/:id
 */
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    let { group_name, monthly_contribution, total_members, interest_percentage, status, notes } = req.body || {};

    const result = await pool.query(`
      UPDATE groups 
      SET group_name = COALESCE($1, group_name),
          monthly_contribution = COALESCE($2, monthly_contribution),
          total_members = COALESCE($3, total_members),
          interest_percentage = COALESCE($4, interest_percentage),
          status = COALESCE($5, status),
          notes = COALESCE($6, notes),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
    `, [group_name, monthly_contribution, total_members, interest_percentage, status, notes, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    res.json({ message: 'Group updated successfully', group: result.rows[0] });
  } catch (err) {
    console.error('Error updating group:', err);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

/**
 * GET MEMBERS OF A GROUP
 * GET /api/groups/:id/members
 */
router.get('/:id/members', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT m.id, m.member_id, m.name, m.email, m.phone, m.balance, gm.joined_at
      FROM group_members gm
      JOIN members m ON gm.member_id = m.id
      WHERE gm.group_id = $1
      ORDER BY m.id ASC
    `, [id]);

    res.json({ members: result.rows });
  } catch (err) {
    console.error('Error fetching group members:', err);
    res.status(500).json({ error: 'Failed to fetch group members' });
  }
});

/**
 * ADD MEMBER TO GROUP
 * POST /api/groups/:id/members
 */
router.post('/:id/members', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { member_id } = req.body;

    if (!member_id) {
      return res.status(400).json({ error: 'Member ID is required.' });
    }

    // Check group capacity
    const groupRes = await pool.query('SELECT total_members FROM groups WHERE id = $1', [id]);
    if (groupRes.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    const maxMembers = groupRes.rows[0].total_members;
    const countRes = await pool.query('SELECT COUNT(*) as cnt FROM group_members WHERE group_id = $1', [id]);
    if (parseInt(countRes.rows[0]?.cnt || 0, 10) >= maxMembers) {
      return res.status(400).json({ error: `Group has reached maximum limit of ${maxMembers} members.` });
    }

    await pool.query(`
      INSERT INTO group_members (group_id, member_id)
      VALUES ($1, $2)
      ON CONFLICT (group_id, member_id) DO NOTHING
    `, [id, member_id]);

    // Also sync group_category in members table
    const groupNameRes = await pool.query('SELECT group_name FROM groups WHERE id = $1', [id]);
    if (groupNameRes.rows.length > 0) {
      await pool.query('UPDATE members SET group_category = $1 WHERE id = $2', [groupNameRes.rows[0].group_name, member_id]);
    }

    res.json({ message: 'Member added to group successfully!' });
  } catch (err) {
    console.error('Error adding member to group:', err);
    res.status(500).json({ error: 'Failed to add member to group' });
  }
});

/**
 * REMOVE MEMBER FROM GROUP
 * DELETE /api/groups/:id/members/:memberId
 */
router.delete('/:id/members/:memberId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, memberId } = req.params;
    await pool.query('DELETE FROM group_members WHERE group_id = $1 AND member_id = $2', [id, memberId]);
    res.json({ message: 'Member removed from group.' });
  } catch (err) {
    console.error('Error removing group member:', err);
    res.status(500).json({ error: 'Failed to remove member from group' });
  }
});

module.exports = router;
