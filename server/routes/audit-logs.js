const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken, requireAdmin);

/**
 * GET /api/admin/audit-logs
 * Fetch admin audit log history
 */
router.get('/', async (req, res) => {
  try {
    const { action = '', search = '', page = 1, limit = 50 } = req.query;

    let conditions = [];
    let params = [];

    if (action) {
      params.push(action);
      conditions.push(`action = $${params.length}`);
    }

    if (search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      const pIdx = params.length;
      conditions.push(`(
        LOWER(actor_name) LIKE $${pIdx} OR 
        LOWER(action) LIKE $${pIdx} OR 
        LOWER(COALESCE(details, '')) LIKE $${pIdx}
      )`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const countRes = await pool.query(`SELECT COUNT(*) FROM audit_logs ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(limitNum, offset);
    const result = await pool.query(
      `SELECT id, actor_type, actor_id, actor_name, action, entity_type, entity_id, details, ip_address, created_at
       FROM audit_logs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      logs: result.rows,
      total,
      page: pageNum,
      limit: limitNum
    });
  } catch (err) {
    console.error('Error fetching audit logs:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

module.exports = router;
