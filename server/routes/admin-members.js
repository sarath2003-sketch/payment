const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Helper to log admin audit trail
async function logAudit(req, action, entityType, entityId, details) {
  try {
    const actorId = req.admin?.id || 1;
    const actorName = req.admin?.username || 'Admin';
    const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    
    await pool.query(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details, ip_address)
       VALUES ('ADMIN', $1, $2, $3, $4, $5, $6, $7)`,
      [actorId, actorName, action, entityType, entityId, details ? JSON.stringify(details) : null, ip]
    );
  } catch (err) {
    console.warn('[Audit Log Warning]', err.message);
  }
}

// Helper to generate next sequential Member ID starting at SF001
async function getNextMemberId(clientOrPool) {
  try {
    const res = await clientOrPool.query(`
      SELECT member_id FROM members 
      WHERE deleted_at IS NULL
    `);
    
    let maxNum = 0;
    for (const row of res.rows || []) {
      if (!row.member_id) continue;
      const match = String(row.member_id).match(/(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    }
    const nextNum = maxNum + 1;
    return `SF${String(nextNum).padStart(3, '0')}`;
  } catch (e) {
    return 'SF001';
  }
}

// All endpoints in this router require Admin authentication
router.use(authenticateToken, requireAdmin);

/**
 * GET /api/admin/members/dashboard-stats
 * Admin dashboard summary stats
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    const statsRes = await pool.query(`
      SELECT 
        COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS total_members,
        COUNT(CASE WHEN deleted_at IS NULL AND activation_status = 'ACTIVE' THEN 1 END) AS active_members,
        COUNT(CASE WHEN deleted_at IS NULL AND (activation_status = 'INACTIVE' OR status = 'INACTIVE') THEN 1 END) AS inactive_members,
        COUNT(CASE WHEN deleted_at IS NULL AND activation_status = 'PENDING' THEN 1 END) AS pending_activations,
        COUNT(CASE WHEN deleted_at IS NULL AND is_duplicate = true AND duplicate_reviewed = false THEN 1 END) AS possible_duplicates,
        (SELECT COUNT(*) FROM payment_proofs) AS total_payments,
        COUNT(CASE WHEN deleted_at IS NULL AND payment_status = 'PAID' THEN 1 END) AS paid_members,
        (SELECT COUNT(*) FROM payment_proofs WHERE status = 'PENDING') AS pending_payments,
        (SELECT COUNT(*) FROM payment_proofs WHERE status = 'REJECTED') AS failed_payments,
        COALESCE((SELECT SUM(amount) FROM payment_proofs WHERE status = 'APPROVED'), 0) AS total_collected
      FROM members
    `);

    res.json(statsRes.rows[0]);
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard summary stats' });
  }
});

/**
 * GET /api/admin/members/lookup/:query
 * Fast lookup of member by Member ID or Name for auto-fill
 */
router.get('/lookup/:query', async (req, res) => {
  try {
    const q = req.params.query.trim();
    const result = await pool.query(`
      SELECT id, member_id AS member_code, name, phone, email, upi_id
      FROM members
      WHERE (CAST(id AS TEXT) = $1 OR member_id = $1 OR phone = $1 OR LOWER(name) LIKE LOWER($2))
        AND deleted_at IS NULL
      LIMIT 5
    `, [q, `%${q}%`]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({ member: result.rows[0], matches: result.rows });
  } catch (err) {
    console.error('Error looking up member:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

/**
 * GET /api/admin/members
 * Search, filter & list members
 */
router.get('/', async (req, res) => {
  try {
    const { 
      search = '', 
      activation_status = '', 
      payment_status = '',
      show_deleted = 'false',
      sort_by = 'created_at',
      sort_dir = 'DESC',
      page = 1,
      limit = 50
    } = req.query;

    let conditions = [];
    let params = [];

    if (show_deleted !== 'true') {
      conditions.push('deleted_at IS NULL');
    }

    if (search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      const pIdx = params.length;
      conditions.push(`(
        LOWER(name) LIKE $${pIdx} OR 
        LOWER(member_id) LIKE $${pIdx} OR 
        LOWER(phone) LIKE $${pIdx} OR 
        LOWER(COALESCE(upi_id, '')) LIKE $${pIdx} OR
        LOWER(email) LIKE $${pIdx}
      )`);
    }

    if (activation_status) {
      params.push(activation_status);
      conditions.push(`activation_status = $${params.length}`);
    }

    if (payment_status) {
      params.push(payment_status);
      conditions.push(`payment_status = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Valid sort fields (safe integer parsing for string member_ids)
    const validSorts = {
      member_id: "CAST(NULLIF(regexp_replace(member_id, '\\D', '', 'g'), '') AS INTEGER)",
      name: 'name',
      created_at: 'created_at',
      activation_status: 'activation_status',
      payment_status: 'payment_status'
    };
    const sortField = validSorts[sort_by] || 'created_at';
    const sortOrder = sort_dir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const countRes = await pool.query(`SELECT COUNT(*) AS count FROM members ${whereClause}`, params);
    const rawCount = countRes.rows[0]?.count ?? countRes.rows[0]?.['COUNT(*)'] ?? countRes.rows[0]?.['count(*)'] ?? 0;
    const totalCount = parseInt(rawCount, 10) || 0;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const queryParams = [...params, limitNum, offset];
    const dataSql = `
      SELECT id, member_id, name, email, phone, upi_id, profile_photo, balance, status, 
             activation_status, payment_status, group_category, is_online, last_active_at,
             is_duplicate, duplicate_reason, duplicate_of_id, duplicate_reviewed, deleted_at, created_at
      FROM members
      ${whereClause}
      ORDER BY ${sortField} ${sortOrder} NULLS LAST
      LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}
    `;

    const membersRes = await pool.query(dataSql, queryParams);

    res.json({
      members: membersRes.rows,
      total: totalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(totalCount / limitNum)
    });
  } catch (err) {
    console.error('Error fetching members:', err);
    res.status(500).json({ error: 'Failed to fetch members list: ' + err.message });
  }
});

/**
 * GET /api/admin/members/duplicates
 * Get list of potential duplicate member registrations
 */
router.get('/duplicates', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m1.id, m1.member_id, m1.name, m1.email, m1.phone, m1.upi_id, m1.profile_photo, m1.activation_status, 
             m1.is_duplicate, m1.duplicate_reason, m1.duplicate_of_id, m1.created_at,
             m2.member_id AS matching_member_id, m2.name AS matching_name, m2.phone AS matching_phone
      FROM members m1
      LEFT JOIN members m2 ON m1.duplicate_of_id = m2.id
      WHERE m1.deleted_at IS NULL AND (
        m1.is_duplicate = true OR 
        m1.duplicate_reason IS NOT NULL OR
        EXISTS (
          SELECT 1 FROM members sub 
          WHERE sub.id != m1.id AND sub.deleted_at IS NULL AND (
            LOWER(sub.name) = LOWER(m1.name) OR 
            sub.phone = m1.phone OR 
            (sub.upi_id IS NOT NULL AND sub.upi_id != '' AND LOWER(sub.upi_id) = LOWER(m1.upi_id))
          )
        )
      )
      ORDER BY m1.name ASC, m1.created_at ASC
    `);

    res.json({ duplicates: result.rows });
  } catch (err) {
    console.error('Error fetching duplicates:', err);
    res.status(500).json({ error: 'Failed to fetch duplicate members' });
  }
});

/**
 * GET /api/admin/members/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const memberRes = await pool.query('SELECT * FROM members WHERE id = $1', [id]);
    
    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberRes.rows[0];
    delete member.password_hash;

    // Fetch payments
    const paymentsRes = await pool.query(
      'SELECT * FROM payment_proofs WHERE member_id = $1 ORDER BY created_at DESC',
      [id]
    );

    res.json({ member, payments: paymentsRes.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch member details' });
  }
});

/**
 * POST /api/admin/members
 * Admin manually adds member with automatic sequential Member ID starting at 101
 */
router.post('/', async (req, res) => {
  let client;
  try {
    let { name, email, phone, upi_id, profile_photo, password, activation_status, payment_status, group_category } = req.body || {};

    name = (name || '').trim();
    phone = (phone || '').trim().replace(/\D/g, '');
    if (phone.length > 10) phone = phone.slice(-10);
    email = (email || '').trim().toLowerCase();
    upi_id = (upi_id || '').trim();
    profile_photo = (profile_photo || '').trim();

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone number are required.' });
    }

    if (phone.length !== 10) {
      return res.status(400).json({ error: 'Phone number must be a valid 10-digit number.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if phone number is already registered to another member
    const existingPhone = await client.query('SELECT id, member_id, name FROM members WHERE phone = $1', [phone]);
    if (existingPhone.rows.length > 0) {
      await client.query('ROLLBACK');
      const m = existingPhone.rows[0];
      return res.status(400).json({ error: `Phone number ${phone} is already registered to Member ID ${m.member_id} (${m.name}).` });
    }

    // Auto-generate or format email cleanly with uniqueness check
    if (!email) {
      email = `member_${phone}@pfchitfund.com`;
    }
    const existingEmail = await client.query('SELECT id FROM members WHERE email = $1', [email]);
    if (existingEmail.rows.length > 0) {
      email = `${email.split('@')[0]}_${Date.now().toString().slice(-4)}@${email.split('@')[1] || 'pfchitfund.com'}`;
    }

    // Check for potential duplicate matching by Name or UPI
    let isDuplicate = false;
    let duplicateReason = null;
    let duplicateOfId = null;

    const dupCheck = await client.query(
      `SELECT id, member_id, name FROM members 
       WHERE LOWER(name) = LOWER($1) OR (upi_id IS NOT NULL AND upi_id != '' AND LOWER(upi_id) = LOWER($2))`,
      [name, upi_id]
    );

    if (dupCheck.rows.length > 0) {
      isDuplicate = true;
      duplicateOfId = dupCheck.rows[0].id;
      duplicateReason = `Matching existing member ${dupCheck.rows[0].member_id} (${dupCheck.rows[0].name})`;
    }

    // Auto-generate next Member ID in SF001 format
    const nextMemberId = await getNextMemberId(client);

    // Auto-generate simple password if blank (e.g. 1235)
    let defaultPwd = (password || '').trim();
    if (!defaultPwd) {
      defaultPwd = String(Math.floor(1000 + Math.random() * 9000));
    }

    const passwordHash = await bcrypt.hash(defaultPwd, 10);
    const mainStatus = (activation_status === 'INACTIVE' || activation_status === 'REJECTED') ? 'INACTIVE' : 'ACTIVE';

    const insertRes = await client.query(
      `INSERT INTO members 
        (member_id, name, email, phone, upi_id, profile_photo, password_hash, status, activation_status, payment_status, group_category, is_duplicate, duplicate_reason, duplicate_of_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, member_id, name, email, phone, upi_id, profile_photo, status, activation_status, payment_status, group_category, created_at`,
      [
        nextMemberId,
        name,
        email,
        phone,
        upi_id || null,
        profile_photo || null,
        passwordHash,
        mainStatus,
        activation_status || 'ACTIVE',
        payment_status || 'UNPAID',
        group_category || 'General',
        isDuplicate,
        duplicateReason,
        duplicateOfId
      ]
    );

    await client.query('COMMIT');
    const newMember = insertRes.rows[0];

    await logAudit(req, 'ADD_MEMBER', 'MEMBER', newMember.id, { member_id: newMember.member_id, name: newMember.name, phone });

    res.status(201).json({
      message: 'Member Created Successfully',
      member: newMember,
      raw_password: defaultPwd
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error adding member:', err);
    res.status(500).json({ error: err.message || 'Failed to add member' });
  } finally {
    if (client) client.release();
  }
});

/**
 * PUT /api/admin/members/:id
 * Edit member details
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let { name, email, phone, upi_id, profile_photo, activation_status, payment_status, group_category, status } = req.body || {};

    const existingRes = await pool.query('SELECT * FROM members WHERE id = $1', [id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const existing = existingRes.rows[0];

    name = (name !== undefined) ? name.trim() : existing.name;
    phone = (phone !== undefined) ? phone.trim().replace(/\D/g, '') : existing.phone;
    if (phone.length > 10) phone = phone.slice(-10);
    email = (email !== undefined) ? email.trim().toLowerCase() : existing.email;
    upi_id = (upi_id !== undefined) ? upi_id.trim() : existing.upi_id;
    profile_photo = (profile_photo !== undefined) ? profile_photo.trim() : existing.profile_photo;
    activation_status = activation_status || existing.activation_status || 'ACTIVE';
    payment_status = payment_status || existing.payment_status || 'UNPAID';
    group_category = group_category || existing.group_category || 'General';
    status = status || existing.status || 'ACTIVE';

    let passwordHash = existing.password_hash;
    if (req.body.password && req.body.password.trim()) {
      passwordHash = await bcrypt.hash(req.body.password.trim(), 10);
    }

    const updateRes = await pool.query(
      `UPDATE members 
       SET name = $1, email = $2, phone = $3, upi_id = $4, profile_photo = $5, activation_status = $6, payment_status = $7, group_category = $8, status = $9, password_hash = $10, updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING id, member_id, name, email, phone, upi_id, profile_photo, activation_status, payment_status, group_category, status`,
      [name, email, phone, upi_id || null, profile_photo || null, activation_status, payment_status, group_category, status, passwordHash, id]
    );

    await logAudit(req, 'EDIT_MEMBER', 'MEMBER', id, { old: existing, updated: updateRes.rows[0] });

    res.json({ message: 'Member updated successfully', member: updateRes.rows[0] });
  } catch (err) {
    console.error('Error updating member:', err);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

/**
 * PATCH /api/admin/members/:id/activation
 * Change activation status (PENDING, ACTIVE, INACTIVE, REJECTED)
 */
router.patch('/:id/activation', async (req, res) => {
  try {
    const { id } = req.params;
    const { activation_status } = req.body;

    if (!['PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED'].includes(activation_status)) {
      return res.status(400).json({ error: 'Invalid activation status' });
    }

    const mainStatus = activation_status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';

    const result = await pool.query(
      `UPDATE members 
       SET activation_status = $1, status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, member_id, name, activation_status, status`,
      [activation_status, mainStatus, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Member not found' });

    await logAudit(req, 'CHANGE_ACTIVATION', 'MEMBER', id, { new_status: activation_status });

    res.json({ message: `Member status updated to ${activation_status}`, member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update activation status' });
  }
});

/**
 * PATCH /api/admin/members/:id/payment-status
 * Change payment status (PAID, UNPAID)
 */
router.patch('/:id/payment-status', async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_status } = req.body;

    if (!['PAID', 'UNPAID'].includes(payment_status)) {
      return res.status(400).json({ error: 'Invalid payment status. Must be PAID or UNPAID.' });
    }

    const result = await pool.query(
      `UPDATE members 
       SET payment_status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, member_id, name, payment_status, status`,
      [payment_status, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Member not found' });

    await logAudit(req, 'CHANGE_PAYMENT_STATUS', 'MEMBER', id, { new_status: payment_status });

    res.json({ message: `Member payment status updated to ${payment_status}`, member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update payment status' });
  }
});

/**
 * PATCH /api/admin/members/:id/deactivate (Soft Delete)
 */
router.patch('/:id/deactivate', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE members 
       SET status = 'INACTIVE', activation_status = 'INACTIVE', deleted_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING id, member_id, name`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Member not found' });

    await logAudit(req, 'DEACTIVATE_MEMBER', 'MEMBER', id, { member_id: result.rows[0].member_id });
    res.json({ message: 'Member deactivated successfully', member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate member' });
  }
});

/**
 * PATCH /api/admin/members/:id/restore
 */
router.patch('/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE members 
       SET status = 'ACTIVE', activation_status = 'ACTIVE', deleted_at = NULL
       WHERE id = $1 RETURNING id, member_id, name`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Member not found' });

    await logAudit(req, 'RESTORE_MEMBER', 'MEMBER', id, { member_id: result.rows[0].member_id });
    res.json({ message: 'Member restored successfully', member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to restore member' });
  }
});

/**
 * DELETE /api/admin/members/:id (Permanent Delete)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const checkRes = await pool.query('SELECT id, member_id, name FROM members WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const member = checkRes.rows[0];
    await pool.query('DELETE FROM members WHERE id = $1', [id]);

    await logAudit(req, 'DELETE_MEMBER_PERMANENT', 'MEMBER', id, { member_id: member.member_id, name: member.name });
    res.json({ message: 'Member permanently deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete member' });
  }
});

/**
 * POST /api/admin/members/resolve-duplicate
 */
router.post('/resolve-duplicate', async (req, res) => {
  try {
    const { keep_id, duplicate_ids, action } = req.body;
    if (!keep_id || !Array.isArray(duplicate_ids)) {
      return res.status(400).json({ error: 'keep_id and duplicate_ids array are required' });
    }

    if (action === 'DEACTIVATE_DUPLICATES') {
      for (const dId of duplicate_ids) {
        await pool.query(
          `UPDATE members SET status = 'INACTIVE', activation_status = 'INACTIVE', is_duplicate = true, duplicate_reviewed = true WHERE id = $1`,
          [dId]
        );
      }
    } else if (action === 'DELETE_DUPLICATES') {
      for (const dId of duplicate_ids) {
        await pool.query('DELETE FROM members WHERE id = $1', [dId]);
      }
    } else {
      for (const dId of duplicate_ids) {
        await pool.query('UPDATE members SET duplicate_reviewed = true WHERE id = $1', [dId]);
      }
    }

    await pool.query('UPDATE members SET is_duplicate = false, duplicate_reviewed = true WHERE id = $1', [keep_id]);
    await logAudit(req, 'RESOLVE_DUPLICATES', 'MEMBER', keep_id, { action, duplicate_ids });

    res.json({ message: 'Duplicates resolved successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve duplicates' });
  }
});

module.exports = router;
