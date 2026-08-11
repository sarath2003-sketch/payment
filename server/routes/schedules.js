const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET SCHEDULE ITEMS FOR A DISTRIBUTION
 * GET /api/schedules/distribution/:distId
 */
router.get('/distribution/:distId', authenticateToken, async (req, res) => {
  try {
    const { distId } = req.params;
    const result = await pool.query(`
      SELECT s.*, m.name as member_name, m.member_id as member_code
      FROM payment_schedules s
      JOIN members m ON s.member_id = m.id
      WHERE s.distribution_id = $1
      ORDER BY s.schedule_number ASC
    `, [distId]);
    res.json({ schedules: result.rows });
  } catch (err) {
    console.error('Error fetching distribution schedules:', err);
    res.status(500).json({ error: 'Failed to fetch payment schedule' });
  }
});

/**
 * GET SCHEDULE ITEMS FOR A MEMBER
 * GET /api/schedules/member/:memberId
 */
router.get('/member/:memberId', authenticateToken, async (req, res) => {
  try {
    let { memberId } = req.params;

    // Security check: members can only view their own schedule
    if (req.admin && req.admin.type === 'member') {
      memberId = req.admin.id;
    }

    const result = await pool.query(`
      SELECT s.*, d.principal_amount, d.interest_percentage, d.interest_amount, d.total_payable, d.number_of_months, d.monthly_amount
      FROM payment_schedules s
      JOIN seed_fund_distributions d ON s.distribution_id = d.id
      WHERE s.member_id = $1
      ORDER BY s.due_date ASC, s.schedule_number ASC
    `, [memberId]);
    res.json({ schedules: result.rows });
  } catch (err) {
    console.error('Error fetching member schedules:', err);
    res.status(500).json({ error: 'Failed to fetch member schedule' });
  }
});

/**
 * MEMBER UPLOADS PROOF FOR A SPECIFIC SCHEDULE ITEM
 * POST /api/schedules/:id/proof
 */
router.post('/:id/proof', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params; // Schedule ID
    const memberId = req.admin ? (req.admin.type === 'member' ? req.admin.id : req.body.member_id) : req.body.member_id;
    const { transaction_reference, image_data } = req.body || {};

    if (!id || !transaction_reference) {
      return res.status(400).json({ error: 'Schedule ID and Transaction Reference are required.' });
    }

    // Verify schedule exists and belongs to member
    const schedRes = await pool.query('SELECT * FROM payment_schedules WHERE id = $1', [id]);
    if (schedRes.rows.length === 0) {
      return res.status(404).json({ error: 'Payment schedule item not found.' });
    }

    const schedule = schedRes.rows[0];

    if (req.admin && req.admin.type === 'member' && String(schedule.member_id) !== String(memberId)) {
      return res.status(403).json({ error: 'Unauthorized: Schedule record does not belong to your account.' });
    }

    let filePath = schedule.proof_file_path || null;

    // Handle base64 image upload if present
    if (image_data && image_data.startsWith('data:image')) {
      const matches = image_data.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const base64Data = matches[2];
        const fileName = `proof_sched_${id}_mem_${memberId}_${Date.now()}.${ext}`;
        const uploadDir = path.join(__dirname, '..', '..', 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        const targetPath = path.join(uploadDir, fileName);
        fs.writeFileSync(targetPath, base64Data, 'base64');
        filePath = `/uploads/${fileName}`;
      }
    }

    const today = new Date().toISOString().split('T')[0];

    // Update schedule record -> WAITING_VERIFICATION
    const updateRes = await pool.query(`
      UPDATE payment_schedules
      SET transaction_reference = $1,
          proof_file_path = COALESCE($2, proof_file_path),
          status = 'WAITING_VERIFICATION',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND member_id = $4
      RETURNING *
    `, [transaction_reference, filePath, id, schedule.member_id]);

    res.json({
      message: 'Payment proof submitted successfully! Awaiting admin verification.',
      schedule: updateRes.rows[0]
    });
  } catch (err) {
    console.error('Error submitting schedule proof:', err);
    res.status(500).json({ error: 'Failed to submit payment proof' });
  }
});

/**
 * ADMIN: GET PENDING PROOFS AWAITING VERIFICATION
 * GET /api/schedules/pending-proofs
 */
router.get('/pending-proofs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, m.name as member_name, m.member_id as member_code, m.phone as member_phone, d.principal_amount, d.monthly_amount
      FROM payment_schedules s
      JOIN members m ON s.member_id = m.id
      JOIN seed_fund_distributions d ON s.distribution_id = d.id
      WHERE s.status = 'WAITING_VERIFICATION' OR s.proof_file_path IS NOT NULL
      ORDER BY s.updated_at DESC
    `);
    res.json({ pending_proofs: result.rows });
  } catch (err) {
    console.error('Error fetching pending proofs:', err);
    res.status(500).json({ error: 'Failed to fetch pending payment proofs' });
  }
});

/**
 * ADMIN: VERIFY / APPROVE / REJECT SCHEDULE PROOF
 * POST /api/schedules/:id/verify
 */
router.post('/:id/verify', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body || {};

    if (!['PAID', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be PAID or REJECTED.' });
    }

    await client.query('BEGIN');

    const schedRes = await client.query('SELECT * FROM payment_schedules WHERE id = $1 FOR UPDATE', [id]);
    if (schedRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment schedule record not found.' });
    }

    const sched = schedRes.rows[0];
    const today = new Date().toISOString().split('T')[0];

    if (status === 'PAID') {
      // Update schedule record
      await client.query(`
        UPDATE payment_schedules
        SET status = 'PAID', amount_paid = amount_due, paid_date = $1, rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [today, id]);

      // Update distribution record total repaid & remaining amount
      const distRes = await client.query('SELECT * FROM seed_fund_distributions WHERE id = $1 FOR UPDATE', [sched.distribution_id]);
      if (distRes.rows.length > 0) {
        const dist = distRes.rows[0];
        const newTotalRepaid = Math.round((parseFloat(dist.total_repaid || 0) + parseFloat(sched.amount_due)) * 100) / 100;
        const newRemaining = Math.max(0, Math.round((parseFloat(dist.total_payable) - newTotalRepaid) * 100) / 100);
        const distStatus = newRemaining <= 0.01 ? 'PAID' : 'PARTIALLY_PAID';

        await client.query(`
          UPDATE seed_fund_distributions
          SET total_repaid = $1, remaining_amount = $2, payment_status = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $4
        `, [newTotalRepaid, newRemaining, distStatus, sched.distribution_id]);

        // Insert transaction record into ledger
        const monthStr = today.substring(0, 7);
        await client.query(`
          INSERT INTO transactions (
            member_id, transaction_date, month, transaction_type, amount, description, reference_type, reference_id, status
          ) VALUES ($1, $2, $3, 'REPAYMENT', $4, $5, 'SCHEDULE', $6, 'COMPLETED')
        `, [
          sched.member_id,
          today,
          monthStr,
          sched.amount_due,
          `Schedule #${sched.schedule_number} Payment for Distribution #${sched.distribution_id} (Ref: ${sched.transaction_reference || 'N/A'})`,
          sched.id
        ]);
      }

      // Update linked notice status if exists
      await client.query(`
        UPDATE notice_board
        SET status = 'PAID', updated_at = CURRENT_TIMESTAMP
        WHERE target_id = $1 AND due_date = $2
      `, [sched.member_id, sched.due_date]);

    } else if (status === 'REJECTED') {
      await client.query(`
        UPDATE payment_schedules
        SET status = 'REJECTED', rejection_reason = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [rejection_reason || 'Payment proof verification failed.', id]);
    }

    await client.query('COMMIT');

    res.json({
      message: `Schedule payment verified and marked as ${status}!`,
      status
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error verifying schedule proof:', err);
    res.status(500).json({ error: 'Failed to verify payment proof' });
  } finally {
    client.release();
  }
});

module.exports = router;
