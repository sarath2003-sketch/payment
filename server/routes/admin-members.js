const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

function saveBase64Image(dataStr, prefix = 'profile') {
  if (!dataStr || typeof dataStr !== 'string' || !dataStr.startsWith('data:image/')) return dataStr;
  try {
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const extMatch = dataStr.match(/^data:image\/(\w+);base64,/);
    const ext = extMatch ? extMatch[1].replace('jpeg', 'jpg') : 'png';
    const base64Data = dataStr.replace(/^data:image\/\w+;base64,/, '');
    const filename = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(base64Data, 'base64'));
    return `/uploads/${filename}`;
  } catch (err) {
    console.error('Error saving base64 image in admin-members:', err);
    return dataStr;
  }
}

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

// Helper to generate next sequential Member ID starting at 101
async function getNextMemberId(clientOrPool) {
  try {
    const res = await clientOrPool.query(`
      SELECT member_id FROM members 
      WHERE deleted_at IS NULL
    `);
    
    let maxNum = 100;
    for (const row of res.rows || []) {
      if (!row.member_id) continue;
      const cleanId = String(row.member_id).replace(/\D/g, '');
      const num = parseInt(cleanId, 10);
      if (!isNaN(num) && num >= 100 && num < 100000 && num > maxNum) {
        maxNum = num;
      }
    }
    const nextNum = maxNum + 1;
    return String(nextNum);
  } catch (e) {
    return '101';
  }
}

// All endpoints in this router require Admin authentication
router.use(authenticateToken, requireAdmin);

/**
 * POST /api/admin/members/reconcile
 * On-demand self-healing: purges orphans, recalculates ledger, syncs WebSocket
 */
router.post('/reconcile', async (req, res) => {
  try {
    const reconciler = req.app.get('reconcileService');
    const io = req.app.get('io');
    if (!reconciler) return res.status(500).json({ error: 'Reconciliation service unavailable' });
    const result = await reconciler.reconcileNow(io, true);
    res.json({ message: 'Database reconciled successfully and synced', details: result });
  } catch (err) {
    res.status(500).json({ error: 'Reconcile failed: ' + err.message });
  }
});

/**
 * GET /api/admin/members/agent/status
 * Get real-time health diagnostics from AI System Guardian / Self-Healing Agent
 */
router.get('/agent/status', async (req, res) => {
  try {
    const reconciler = req.app.get('reconcileService');
    if (!reconciler) return res.status(500).json({ error: 'Reconciliation service unavailable' });
    const diagnostics = await reconciler.getDiagnostics();
    res.json(diagnostics);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve agent status: ' + err.message });
  }
});

/**
 * POST /api/admin/members/agent/heal-now
 * Trigger deep diagnostics scan & immediate self-healing sweep
 */
router.post('/agent/heal-now', async (req, res) => {
  try {
    const reconciler = req.app.get('reconcileService');
    const io = req.app.get('io');
    if (!reconciler) return res.status(500).json({ error: 'Reconciliation service unavailable' });
    const result = await reconciler.reconcileNow(io, true);
    const diagnostics = await reconciler.getDiagnostics();
    res.json({ message: 'Self-healing sweep completed successfully', result, diagnostics });
  } catch (err) {
    res.status(500).json({ error: 'Self-healing failed: ' + err.message });
  }
});

/**
 * GET /api/admin/members/dashboard-stats
 * Admin dashboard summary stats (Synchronized strictly with active members)
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    const statsRes = await pool.query(`
      SELECT 
        COUNT(CASE WHEN deleted_at IS NULL AND status = 'ACTIVE' THEN 1 END) AS total_members,
        COUNT(CASE WHEN deleted_at IS NULL AND status = 'ACTIVE' AND activation_status = 'ACTIVE' THEN 1 END) AS active_members,
        COUNT(CASE WHEN deleted_at IS NULL AND (activation_status = 'INACTIVE' OR status = 'INACTIVE') THEN 1 END) AS inactive_members,
        COUNT(CASE WHEN deleted_at IS NULL AND activation_status = 'PENDING' THEN 1 END) AS pending_activations,
        COUNT(CASE WHEN deleted_at IS NULL AND is_duplicate = true AND duplicate_reviewed = false THEN 1 END) AS possible_duplicates,
        (SELECT COUNT(*) FROM payment_proofs p JOIN members m ON p.member_id = m.id WHERE m.deleted_at IS NULL AND m.status = 'ACTIVE') AS total_payments,
        COUNT(CASE WHEN deleted_at IS NULL AND status = 'ACTIVE' AND payment_status = 'PAID' THEN 1 END) AS paid_members,
        (SELECT COUNT(*) FROM payment_proofs p JOIN members m ON p.member_id = m.id WHERE p.status = 'PENDING' AND m.deleted_at IS NULL AND m.status = 'ACTIVE') AS pending_payments,
        (SELECT COUNT(*) FROM payment_proofs p JOIN members m ON p.member_id = m.id WHERE p.status = 'REJECTED' AND m.deleted_at IS NULL AND m.status = 'ACTIVE') AS failed_payments,
        COALESCE((SELECT SUM(p.amount) FROM payment_proofs p JOIN members m ON p.member_id = m.id WHERE p.status = 'APPROVED' AND m.deleted_at IS NULL AND m.status = 'ACTIVE'), 0) AS total_collected,
        COALESCE((SELECT SUM(amount) FROM withdrawals WHERE reason = 'MEMBER_EXIT_REFUND'), 0) AS total_refunded_exited,
        COALESCE((SELECT SUM(amount) FROM withdrawals), 0) AS total_withdrawn,
        COALESCE((SELECT SUM(interest_amount) FROM seed_fund_distributions), 0) AS total_interest_earned,
        COALESCE((SELECT SUM(principal_amount) FROM seed_fund_distributions), 0) AS total_loans_given,
        COALESCE((SELECT SUM(payment_amount) FROM repayments WHERE status = 'COMPLETED'), 0) AS total_repaid
      FROM members
    `);

    const row = statsRes.rows[0] || {};
    const totalCollected = parseFloat(row.total_collected || 0);
    const totalRefundedExited = parseFloat(row.total_refunded_exited || 0);
    const totalWithdrawn = parseFloat(row.total_withdrawn || 0);
    const totalInterestEarned = parseFloat(row.total_interest_earned || 0);
    const totalLoansGiven = parseFloat(row.total_loans_given || 0);
    const totalRepaid = parseFloat(row.total_repaid || 0);

    // Net current balance in fund
    const currentBalance = Math.max(0, Math.round((totalCollected + totalRepaid - totalLoansGiven - (totalWithdrawn - totalRefundedExited) - totalRefundedExited) * 100) / 100);

    res.json({
      total_members: parseInt(row.total_members || 0, 10),
      active_members: parseInt(row.active_members || 0, 10),
      inactive_members: parseInt(row.inactive_members || 0, 10),
      pending_activations: parseInt(row.pending_activations || 0, 10),
      possible_duplicates: parseInt(row.possible_duplicates || 0, 10),
      total_payments: parseInt(row.total_payments || 0, 10),
      paid_members: parseInt(row.paid_members || 0, 10),
      pending_payments: parseInt(row.pending_payments || 0, 10),
      failed_payments: parseInt(row.failed_payments || 0, 10),
      total_collected: totalCollected,
      total_refunded_exited: totalRefundedExited,
      total_interest_earned: totalInterestEarned,
      total_loans_given: totalLoansGiven,
      current_balance: currentBalance
    });
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard summary stats' });
  }
});

/**
 * GET /api/admin/members/lookup/:query
 * Fast lookup of member by Member ID, Name, or Phone for auto-fill
 */
router.get('/lookup/:query', async (req, res) => {
  try {
    const q = req.params.query.trim();
    const cleanDigits = q.replace(/\D/g, '');
    const strippedSF = q.replace(/^SF/i, '').trim();
    const result = await pool.query(`
      SELECT id, member_id AS member_code, name, phone, email, upi_id
      FROM members
      WHERE (
        CAST(id AS TEXT) = $1 
        OR member_id = $1 
        OR member_id = $2
        OR ('SF' || member_id) = $1
        OR phone = $1 
        OR (phone = $3 AND LENGTH($3) >= 10)
        OR LOWER(TRIM(name)) = LOWER(TRIM($1))
        OR LOWER(name) LIKE LOWER($4)
      )
      AND deleted_at IS NULL
      LIMIT 10
    `, [q, strippedSF, cleanDigits, `%${q}%`]);

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
    profile_photo = saveBase64Image((profile_photo || '').trim());

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone number are required.' });
    }

    if (phone.length !== 10) {
      return res.status(400).json({ error: 'Phone number must be a valid 10-digit number.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Clean up any old soft-deleted records holding this phone or email
    await client.query('DELETE FROM members WHERE (phone = $1 OR email = $2) AND deleted_at IS NOT NULL', [phone, email]);

    // Check if phone number is already registered to another active member
    const existingPhone = await client.query('SELECT id, member_id, name FROM members WHERE phone = $1 AND deleted_at IS NULL', [phone]);
    if (existingPhone.rows.length > 0) {
      await client.query('ROLLBACK');
      const m = existingPhone.rows[0];
      return res.status(400).json({ error: `Phone number ${phone} is already registered to Member ID ${m.member_id} (${m.name}).` });
    }

    // Auto-generate or format email cleanly with uniqueness check
    if (!email) {
      email = `member_${phone}@pfchitfund.com`;
    }
    await client.query('DELETE FROM members WHERE email = $1 AND deleted_at IS NOT NULL', [email]);
    const existingEmail = await client.query('SELECT id FROM members WHERE email = $1 AND deleted_at IS NULL', [email]);
    if (existingEmail.rows.length > 0) {
      email = `${email.split('@')[0]}_${Date.now().toString().slice(-4)}@${email.split('@')[1] || 'pfchitfund.com'}`;
    }

    // Check for potential duplicate matching by Name
    let isDuplicate = false;
    let duplicateReason = null;
    let duplicateOfId = null;

    const dupCheck = await client.query(
      `SELECT id, member_id, name FROM members 
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND deleted_at IS NULL`,
      [name]
    );

    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      const dup = dupCheck.rows[0];
      return res.status(400).json({ 
        error: `Member "${dup.name}" already exists with Member ID ${dup.member_id}. Duplicate names are not allowed.` 
      });
    }

    // Auto-generate next Member ID starting at 101
    const nextMemberId = await getNextMemberId(client);

    // Auto-generate simple password if blank (defaults to standard 123456)
    let defaultPwd = (password || '').trim();
    if (!defaultPwd) {
      defaultPwd = '123456';
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
    await logAudit(req, 'ADD_MEMBER', 'MEMBER', newMember.id, { member_id: newMember.member_id, name: newMember.name, phone });

    const io = req.app.get('io');
    if (io) {
      io.emit('member:added', newMember);
      io.emit('stats:updated');
    }
    const reconciler = req.app.get('reconcileService');
    if (reconciler) reconciler.reconcileNow(io, false).catch(e => console.error(e));

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
    profile_photo = (profile_photo !== undefined) ? saveBase64Image(profile_photo.trim()) : existing.profile_photo;
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

    const io = req.app.get('io');
    if (io) {
      io.emit('member:profile-updated', updateRes.rows[0]);
    }

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

    const io = req.app.get('io');
    if (io) {
      io.emit('member:updated', result.rows[0]);
      io.emit('stats:updated');
    }
    const reconciler = req.app.get('reconcileService');
    if (reconciler) reconciler.reconcileNow(io, false).catch(e => console.error(e));

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

    const io = req.app.get('io');
    if (io) {
      io.emit('member:updated', result.rows[0]);
      io.emit('stats:updated');
    }
    const reconciler = req.app.get('reconcileService');
    if (reconciler) reconciler.reconcileNow(io, false).catch(e => console.error(e));

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
 * DELETE /api/admin/members/:id
 * Member Exit Settlement & Audit Preservation:
 * 1. Calculates total approved principal paid by the member into the fund.
 * 2. If > 0, records an EXIT_REFUND withdrawal and transaction (funds returned to member).
 * 3. Keeps past payment_proofs, monthly_payments, and transactions linked for Excel/PDF audits.
 * 4. Marks member as 'EXITED', deleted_at = CURRENT_TIMESTAMP, balance = 0.
 * 5. Frees up mobile phone and email so they can register afresh if needed.
 * 6. Broadcasts real-time events to sync Admin and Public portals immediately.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const checkRes = await pool.query('SELECT id, member_id, name, phone, email FROM members WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const member = checkRes.rows[0];

    // 1. Calculate the total principal paid by this member (invest amount / அசல்)
    const paidProofsRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM payment_proofs WHERE member_id = $1 AND (status = 'APPROVED' OR status = 'PAID')",
      [id]
    );
    const paidMonthlyRes = await pool.query(
      "SELECT COALESCE(SUM(amount_paid), 0) AS total FROM monthly_payments WHERE member_id = $1 AND (status = 'PAID' OR amount_paid > 0)",
      [id]
    );
    const totalPrincipalPaid = Math.max(
      parseFloat(paidProofsRes.rows[0]?.total || 0),
      parseFloat(paidMonthlyRes.rows[0]?.total || 0)
    );

    const todayDate = new Date().toISOString().split('T')[0];
    const currentMonth = todayDate.substring(0, 7);

    // 2. If the member had paid principal into the fund, record a formal EXIT_REFUND settlement
    if (totalPrincipalPaid > 0) {
      await pool.query(
        `INSERT INTO withdrawals (member_id, month, withdrawal_date, amount, reason, notes) 
         VALUES ($1, $2, $3, $4, 'MEMBER_EXIT_REFUND', $5)`,
        [id, currentMonth, todayDate, totalPrincipalPaid, `Principal contribution of ₹${totalPrincipalPaid} refunded on member exit for ${member.name} (${member.member_id})`]
      );

      await pool.query(
        `INSERT INTO transactions (member_id, transaction_date, month, transaction_type, amount, description, balance_after)
         VALUES ($1, $2, $3, 'EXIT_REFUND', $4, $5, 0)`,
        [id, todayDate, currentMonth, totalPrincipalPaid, `Member Exit Settlement: Full principal refund of ₹${totalPrincipalPaid} returned to ${member.name} (${member.member_id})`]
      );
    }

    // 3. Remove from active non-financial associations (group membership, nominees, notices)
    await pool.query('DELETE FROM group_members WHERE member_id = $1', [id]);
    await pool.query('DELETE FROM nominees WHERE member_id = $1', [id]);
    await pool.query("DELETE FROM notice_board WHERE target_id = $1 AND target_type = 'MEMBER'", [id]);
    await pool.query('DELETE FROM payment_schedules WHERE member_id = $1', [id]);

    // 4. Soft-delete the member, preserve history, and free up member_id, phone, and email
    const exitedPhone = `${member.phone}_exited_${id}_${Date.now()}`;
    const exitedEmail = `${member.email || ''}_exited_${id}_${Date.now()}`;
    const exitedMemberId = `${member.member_id}_exited_${id}_${Date.now()}`;
    await pool.query(
      `UPDATE members 
       SET status = 'EXITED',
           activation_status = 'INACTIVE',
           member_id = $1,
           phone = $2,
           email = $3,
           balance = 0,
           deleted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [exitedMemberId, exitedPhone, exitedEmail, id]
    );

    await logAudit(req, 'MEMBER_EXIT_SETTLED', 'MEMBER', id, { 
      member_id: member.member_id, 
      name: member.name,
      refunded_principal: totalPrincipalPaid 
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('member:deleted', { id, member_code: member.member_id, name: member.name, refunded_principal: totalPrincipalPaid });
      io.emit('stats:updated');
      io.emit('payment:approved');
      io.emit('seed_fund:updated');
    }

    const reconciler = req.app.get('reconcileService');
    if (reconciler) {
      reconciler.reconcileNow(io, false).catch(e => console.error(e));
    }

    return res.json({ 
      success: true,
      message: `Member ${member.name} exited successfully. Principal of ₹${totalPrincipalPaid} refunded and audit history preserved.`,
      refunded_principal: totalPrincipalPaid
    });
  } catch (err) {
    console.error('Error exiting member:', err);
    res.status(500).json({ error: 'Failed to exit member: ' + err.message });
  }
});

/**
 * POST /api/admin/members/:id/restore (Reactivate Member)
 */
router.post('/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`
      UPDATE members 
      SET status = 'ACTIVE', 
          activation_status = 'ACTIVE', 
          deleted_at = NULL, 
          updated_at = CURRENT_TIMESTAMP 
      WHERE id = $1
    `, [id]);

    await logAudit(req, 'RESTORE_MEMBER', 'MEMBER', id, {});
    const io = req.app.get('io');
    if (io) io.emit('stats:updated');

    res.json({ success: true, message: 'Member reactivated successfully.' });
  } catch (err) {
    console.error('Restore member error:', err);
    res.status(500).json({ error: 'Failed to reactivate member: ' + err.message });
  }
});

/**
 * POST /api/admin/members/clean-test-data (Purge all orphan records & test data)
 */
router.post('/clean-test-data', async (req, res) => {
  try {
    // Delete orphan distributions and proofs where member no longer exists
    await pool.query('DELETE FROM seed_fund_distributions WHERE member_id NOT IN (SELECT id FROM members)');
    await pool.query('DELETE FROM payment_schedules WHERE member_id NOT IN (SELECT id FROM members)');
    await pool.query('DELETE FROM payment_proofs WHERE member_id NOT IN (SELECT id FROM members)');
    await pool.query('DELETE FROM monthly_payments WHERE member_id NOT IN (SELECT id FROM members)');
    await pool.query('DELETE FROM repayments WHERE member_id NOT IN (SELECT id FROM members)');
    await pool.query('DELETE FROM transactions WHERE member_id NOT IN (SELECT id FROM members)');
    await pool.query('DELETE FROM notice_board WHERE target_id NOT IN (SELECT id FROM members)');
    await pool.query('DELETE FROM nominees WHERE member_id NOT IN (SELECT id FROM members)');

    const io = req.app.get('io');
    if (io) {
      io.emit('stats:updated');
      io.emit('seed_fund:updated');
    }

    res.json({ message: 'All orphaned test data and ghost transactions cleaned up successfully!' });
  } catch (err) {
    console.error('Error cleaning test data:', err);
    res.status(500).json({ error: 'Failed to clean test data: ' + err.message });
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
