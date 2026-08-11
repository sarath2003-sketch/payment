const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * Upload payment proof - creates PENDING record
 * POST /api/payment-verification/upload-proof
 */
router.post('/upload-proof', authenticateToken, async (req, res) => {
  try {
    if (!req.files || !req.files.proof) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { member_id, payment_date, amount, transaction_reference } = req.body;

    if (!member_id || !payment_date || !amount) {
      return res.status(400).json({ error: 'member_id, payment_date, and amount are required' });
    }

    const proofFile = req.files.proof;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedMimes.includes(proofFile.mimetype)) {
      return res.status(400).json({ 
        error: 'Only image files (JPEG, PNG, WebP) and PDF are allowed' 
      });
    }

    if (proofFile.size > 5 * 1024 * 1024) {
      return res.status(400).json({ 
        error: 'File size must be less than 5MB' 
      });
    }

    const timestamp = Date.now();
    const fileName = `proof_${member_id}_${timestamp}_${proofFile.name}`;
    const filePath = path.join(uploadDir, fileName);

    await proofFile.mv(filePath);

    const proof = await pool.query(
      `INSERT INTO payment_proofs (member_id, amount, transaction_reference, payment_date, proof_file_path, proof_file_name, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING') RETURNING *`,
      [member_id, amount, transaction_reference || null, payment_date, filePath, fileName]
    );

    res.json({
      message: 'Payment proof uploaded successfully',
      proof_id: proof.rows[0].id,
      status: 'PENDING',
      note: 'Your payment proof has been submitted for admin verification.'
    });

  } catch (error) {
    console.error('Error uploading proof:', error);
    res.status(500).json({ error: 'Failed to upload payment proof' });
  }
});

// Get payment proofs for a member
router.get('/proofs/:member_id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, member_id, amount, transaction_reference, payment_date, status, rejection_reason, verified_by, verified_at, created_at
       FROM payment_proofs 
       WHERE member_id = $1 
       ORDER BY created_at DESC`,
      [req.params.member_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching proofs:', error);
    res.status(500).json({ error: 'Failed to fetch payment proofs' });
  }
});

// Get pending proofs (admin only)
router.get('/pending-proofs', authenticateToken, async (req, res) => {
  try {
    if (req.admin?.type === 'member') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await pool.query(
      `SELECT 
        pp.id,
        pp.member_id,
        m.name as member_name,
        m.member_id as member_code,
        pp.amount,
        pp.transaction_reference,
        pp.payment_date,
        pp.status,
        pp.proof_file_path,
        pp.proof_file_name,
        pp.created_at
       FROM payment_proofs pp
       JOIN members m ON pp.member_id = m.id
       WHERE pp.status = 'PENDING'
       ORDER BY pp.created_at ASC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pending proofs:', error);
    res.status(500).json({ error: 'Failed to fetch pending proofs' });
  }
});

// Admin verifies payment proof
router.post('/verify-proof/:proof_id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.admin?.type === 'member') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { verified, rejection_reason } = req.body;

    if (verified === undefined) {
      return res.status(400).json({ error: 'Verification status (verified: true/false) is required' });
    }

    await client.query('BEGIN');

    const proofResult = await client.query(
      'SELECT id, member_id, amount, payment_date FROM payment_proofs WHERE id = $1 FOR UPDATE',
      [req.params.proof_id]
    );

    if (proofResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Proof not found' });
    }

    const { member_id, amount, payment_date } = proofResult.rows[0];
    const newStatus = verified ? 'APPROVED' : 'REJECTED';

    await client.query(
      `UPDATE payment_proofs 
       SET status = $1, rejection_reason = $2, verified_by = $3, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [newStatus, verified ? null : (rejection_reason || 'Rejected by admin'), req.admin?.id || 1, req.params.proof_id]
    );

    if (verified) {
      // Update member balance
      await client.query(
        'UPDATE members SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [amount, member_id]
      );

      // Create or update monthly_payments record if applicable
      const pDate = new Date(payment_date);
      const year = pDate.getFullYear();
      const month = pDate.getMonth() + 1;

      const existingMonthly = await client.query(
        'SELECT id FROM monthly_payments WHERE member_id = $1 AND year = $2 AND month = $3',
        [member_id, year, month]
      );

      if (existingMonthly.rows.length > 0) {
        await client.query(
          `UPDATE monthly_payments 
           SET amount_paid = COALESCE(amount_paid, 0) + $1, status = 'PAID', payment_date = $2, payment_proof_id = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [amount, payment_date, req.params.proof_id, existingMonthly.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO monthly_payments (member_id, year, month, amount_due, amount_paid, status, payment_date, payment_proof_id)
           VALUES ($1, $2, $3, 500.00, $4, 'PAID', $5, $6)`,
          [member_id, year, month, amount, payment_date, req.params.proof_id]
        );
      }
    }

    await client.query('COMMIT');

    res.json({
      message: verified ? 'Payment approved successfully' : 'Payment rejected',
      status: newStatus
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error verifying proof:', error);
    res.status(500).json({ error: 'Failed to verify payment proof' });
  } finally {
    client.release();
  }
});

// Alias: PUT /api/payments/:id/approve & PUT /api/payment-verification/:id/approve
router.put('/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  const proofId = req.params.id;
  const verified = req.body.status !== 'REJECTED';
  const notes = req.body.notes || 'Approved by Admin';
  const adminId = req.admin.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proofRes = await client.query('SELECT * FROM payment_proofs WHERE id = $1', [proofId]);
    if (proofRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    const proof = proofRes.rows[0];
    const newStatus = verified ? 'APPROVED' : 'REJECTED';

    await client.query(`
      UPDATE payment_proofs 
      SET status = $1, admin_notes = $2, verified_by = $3, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [newStatus, notes, adminId, proofId]);

    if (verified) {
      await client.query("UPDATE members SET payment_status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [proof.member_id]);
      await client.query(`
        INSERT INTO transactions (member_id, transaction_date, transaction_time, month, transaction_type, amount, description, reference_type, reference_id, status)
        VALUES ($1, CURRENT_DATE, '12:00:00', $2, 'PAYMENT', $3, $4, 'PAYMENT_PROOF', $5, 'COMPLETED')
      `, [proof.member_id, proof.payment_month || '2026-08', proof.amount, `Payment Approved (Ref: ${proof.transaction_reference || 'N/A'})`, proofId]);
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Payment ${newStatus.toLowerCase()} successfully`, status: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error approving payment:', err);
    res.status(500).json({ success: false, message: 'Failed to approve payment' });
  } finally {
    client.release();
  }
});

module.exports = router;
