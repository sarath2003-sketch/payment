const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/seettu/cycles - Get all Seettu cycles
router.get('/cycles', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.*,
        w.name AS winner_name,
        w.member_id AS winner_code,
        w.phone AS winner_phone
      FROM seettu_cycles s
      LEFT JOIN members w ON s.winner_member_id = w.id
      ORDER BY s.created_at DESC
    `);

    // Ensure numeric calculations (20 members * 1000 contribution = 20000 collection)
    const cycles = result.rows.map(c => {
      const totalMembers = parseInt(c.total_members || 20, 10);
      const monthlyContribution = parseFloat(c.monthly_contribution || 1000);
      const totalCollection = totalMembers * monthlyContribution;
      const amountDistributed = parseFloat(c.amount_distributed || 0);
      const remainingAmount = totalCollection - amountDistributed;

      return {
        ...c,
        total_members: totalMembers,
        monthly_contribution: monthlyContribution,
        total_collection: totalCollection,
        amount_distributed: amountDistributed,
        remaining_amount: remainingAmount
      };
    });

    res.json({ cycles });
  } catch (error) {
    console.error('Error fetching Seettu cycles:', error);
    res.status(500).json({ error: 'Failed to fetch Seettu cycles' });
  }
});

// GET /api/seettu/cycles/:id - Get specific Seettu cycle with member payments breakdown
router.get('/cycles/:id', authenticateToken, async (req, res) => {
  try {
    const cycleRes = await pool.query(`
      SELECT 
        s.*,
        w.name AS winner_name,
        w.member_id AS winner_code,
        w.phone AS winner_phone
      FROM seettu_cycles s
      LEFT JOIN members w ON s.winner_member_id = w.id
      WHERE s.id = $1
    `, [req.params.id]);

    if (cycleRes.rows.length === 0) {
      return res.status(404).json({ error: 'Seettu cycle not found' });
    }

    const c = cycleRes.rows[0];
    const totalMembers = parseInt(c.total_members || 20, 10);
    const monthlyContribution = parseFloat(c.monthly_contribution || 1000);
    const totalCollection = totalMembers * monthlyContribution;
    const amountDistributed = parseFloat(c.amount_distributed || 0);
    const remainingAmount = totalCollection - amountDistributed;

    // Fetch members participation & payment status for this cycle month
    const membersRes = await pool.query(`
      SELECT 
        m.id,
        m.member_id AS member_code,
        m.name,
        m.phone,
        COALESCE(p.amount, 0) AS amount_paid,
        COALESCE(p.status, 'PENDING') AS payment_status,
        p.transaction_reference,
        p.created_at AS payment_date
      FROM members m
      LEFT JOIN payment_proofs p ON m.id = p.member_id AND p.payment_month = $1
      WHERE m.deleted_at IS NULL
      ORDER BY m.id ASC
    `, [c.cycle_month]);

    res.json({
      cycle: {
        ...c,
        total_members: totalMembers,
        monthly_contribution: monthlyContribution,
        total_collection: totalCollection,
        amount_distributed: amountDistributed,
        remaining_amount: remainingAmount
      },
      members: membersRes.rows
    });
  } catch (error) {
    console.error('Error fetching Seettu cycle detail:', error);
    res.status(500).json({ error: 'Failed to fetch Seettu cycle details' });
  }
});

// POST /api/seettu/cycles - Admin create new Seettu cycle
router.post('/cycles', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      cycle_month,
      total_members = 20,
      monthly_contribution = 1000,
      notes
    } = req.body;

    if (!title || !cycle_month) {
      return res.status(400).json({ error: 'Title and Cycle Month (e.g. 2026-08) are required' });
    }

    const membersCount = parseInt(total_members, 10);
    const contribution = parseFloat(monthly_contribution);
    const totalCollection = membersCount * contribution;

    const result = await pool.query(`
      INSERT INTO seettu_cycles (
        title, cycle_month, total_members, monthly_contribution,
        total_collection, amount_distributed, remaining_amount,
        status, notes
      ) VALUES ($1, $2, $3, $4, $5, 0, $5, 'ACTIVE', $6)
      RETURNING *
    `, [title, cycle_month, membersCount, contribution, totalCollection, notes || null]);

    // Audit Log
    await pool.query(`
      INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details)
      VALUES ('admin', $1, 'Admin', 'CREATE_SEETTU_CYCLE', 'seettu_cycle', $2, $3)
    `, [req.admin.id, result.rows[0].id, `Created Seettu cycle: ${title} (${cycle_month})`]);

    res.status(201).json({ message: 'Seettu cycle created successfully', cycle: result.rows[0] });
  } catch (error) {
    console.error('Error creating Seettu cycle:', error);
    res.status(500).json({ error: 'Failed to create Seettu cycle' });
  }
});

// PUT /api/seettu/cycles/:id - Admin edit Seettu cycle
router.put('/cycles/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, cycle_month, total_members, monthly_contribution, notes, status } = req.body;
    const cycleId = req.params.id;

    const cycleRes = await pool.query('SELECT * FROM seettu_cycles WHERE id = $1', [cycleId]);
    if (cycleRes.rows.length === 0) {
      return res.status(404).json({ error: 'Seettu cycle not found' });
    }

    const membersCount = parseInt(total_members || cycleRes.rows[0].total_members, 10);
    const contribution = parseFloat(monthly_contribution || cycleRes.rows[0].monthly_contribution);
    const totalCollection = membersCount * contribution;

    const updated = await pool.query(`
      UPDATE seettu_cycles SET
        title = COALESCE($1, title),
        cycle_month = COALESCE($2, cycle_month),
        total_members = $3,
        monthly_contribution = $4,
        total_collection = $5,
        remaining_amount = $5 - COALESCE(amount_distributed, 0),
        notes = COALESCE($6, notes),
        status = COALESCE($7, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [title, cycle_month, membersCount, contribution, totalCollection, notes, status, cycleId]);

    // Audit log
    await pool.query(`
      INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details)
      VALUES ('admin', $1, 'Admin', 'UPDATE_SEETTU_CYCLE', 'seettu_cycle', $2, $3)
    `, [req.admin.id, cycleId, `Updated Seettu cycle #${cycleId}`]);

    res.json({ message: 'Seettu cycle updated successfully', cycle: updated.rows[0] });
  } catch (error) {
    console.error('Error updating Seettu cycle:', error);
    res.status(500).json({ error: 'Failed to update Seettu cycle' });
  }
});

// DELETE /api/seettu/cycles/:id - Admin delete/deactivate Seettu cycle
router.delete('/cycles/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cycleId = req.params.id;
    const cycleRes = await pool.query('SELECT * FROM seettu_cycles WHERE id = $1', [cycleId]);
    if (cycleRes.rows.length === 0) {
      return res.status(404).json({ error: 'Seettu cycle not found' });
    }

    await pool.query("UPDATE seettu_cycles SET status = 'DELETED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [cycleId]);

    // Audit log
    await pool.query(`
      INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details)
      VALUES ('admin', $1, 'Admin', 'DELETE_SEETTU_CYCLE', 'seettu_cycle', $2, $3)
    `, [req.admin.id, cycleId, `Deleted/Deactivated Seettu cycle #${cycleId}`]);

    res.json({ message: 'Seettu cycle deleted successfully' });
  } catch (error) {
    console.error('Error deleting Seettu cycle:', error);
    res.status(500).json({ error: 'Failed to delete Seettu cycle' });
  }
});

// POST /api/seettu/cycles/:id/distributions - Save amount distributions for a cycle
router.post('/cycles/:id/distributions', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cycleId = req.params.id;
    const { distributions } = req.body; // Array of { member_id, amount, notes }

    if (!Array.isArray(distributions) || distributions.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Please add at least one member distribution' });
    }

    const cycleRes = await client.query('SELECT * FROM seettu_cycles WHERE id = $1', [cycleId]);
    if (cycleRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Seettu cycle not found' });
    }
    const cycle = cycleRes.rows[0];
    const totalCollection = parseFloat(cycle.total_collection || (cycle.total_members * cycle.monthly_contribution));

    // Calculate sum of proposed distributions
    let totalDistributed = 0;
    const validRows = [];

    for (const d of distributions) {
      const amt = parseFloat(d.amount);
      if (isNaN(amt) || amt <= 0) continue;

      // Verify member exists
      const memRes = await client.query('SELECT id, member_id AS member_code, name FROM members WHERE (CAST(id AS TEXT) = $1 OR member_id = $1) AND deleted_at IS NULL', [String(d.member_id)]);
      if (memRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Member ID ${d.member_id} not found in database` });
      }

      totalDistributed += amt;
      validRows.push({
        member_pk: memRes.rows[0].id,
        member_code: memRes.rows[0].member_code,
        name: memRes.rows[0].name,
        amount: amt,
        notes: d.notes || ''
      });
    }

    // STRICT VALIDATION: sum <= totalCollection
    if (totalDistributed > totalCollection) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Total distributed amount (₹${totalDistributed.toLocaleString('en-IN')}) exceeds available collection amount (₹${totalCollection.toLocaleString('en-IN')}). Please adjust amounts.`
      });
    }

    // Record distributions in transactions / ledger table
    const todayDate = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toTimeString().split(' ')[0];

    for (const row of validRows) {
      await client.query(`
        INSERT INTO transactions (
          member_id, transaction_date, transaction_time, month,
          transaction_type, amount, description, seettu_cycle_id,
          reference_type, reference_id, status
        ) VALUES ($1, $2, $3, $4, 'CREDIT', $5, $6, $7, 'SEETTU_DISTRIBUTION', $7, 'COMPLETED')
      `, [
        row.member_pk,
        todayDate,
        timeStr,
        cycle.cycle_month,
        row.amount,
        `Seettu Amount Distribution — ${cycle.title} (${cycle.cycle_month})`,
        cycleId
      ]);
    }

    // Update seettu_cycles table amount_distributed and remaining_amount
    const updatedCycle = await client.query(`
      UPDATE seettu_cycles SET
        amount_distributed = $1,
        remaining_amount = $2 - $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [totalDistributed, totalCollection, cycleId]);

    await client.query('COMMIT');

    res.json({
      message: `Successfully saved amount distributions (₹${totalDistributed.toLocaleString('en-IN')} distributed)`,
      cycle: updatedCycle.rows[0],
      distributed_count: validRows.length
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving Seettu distributions:', error);
    res.status(500).json({ error: 'Failed to save amount distributions' });
  } finally {
    client.release();
  }
});

// GET /api/seettu/summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(id) AS total_cycles,
        COALESCE(SUM(total_collection), 0) AS grand_total_collected,
        COALESCE(SUM(amount_distributed), 0) AS grand_total_distributed
      FROM seettu_cycles
    `);
    res.json(result.rows[0] || { total_cycles: 0, grand_total_collected: 0, grand_total_distributed: 0 });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

module.exports = router;
