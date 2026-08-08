const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * CRITICAL SECURITY POLICY:
 * Payment proofs are NOT automatically verified.
 * Uploaded screenshots are for documentation only.
 * ACTUAL VERIFICATION must come from:
 * 1. Payment gateway API confirmation
 * 2. Bank statement verification
 * 3. Admin manual review
 * 
 * DO NOT mark payments as successful based only on image uploads.
 */

// Upload payment proof - creates PENDING record, not automatic verification
router.post('/upload-proof', authenticateToken, async (req, res) => {
  try {
    if (!req.files || !req.files.proof) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { member_id, month, amount, transaction_id } = req.body;

    if (!member_id || !month || !amount) {
      return res.status(400).json({ error: 'member_id, month, and amount are required' });
    }

    const proofFile = req.files.proof;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';

    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Validate file is an image
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedMimes.includes(proofFile.mimetype)) {
      return res.status(400).json({ 
        error: 'Only image files (JPEG, PNG, WebP) and PDF are allowed' 
      });
    }

    // Validate file size (max 5MB)
    if (proofFile.size > 5 * 1024 * 1024) {
      return res.status(400).json({ 
        error: 'File size must be less than 5MB' 
      });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const fileName = `proof_${member_id}_${month}_${timestamp}_${proofFile.name}`;
    const filePath = path.join(uploadDir, fileName);

    // Save file
    await proofFile.mv(filePath);

    // Check if payment already exists for this month
    const existingPayment = await pool.query(
      'SELECT id FROM monthly_payments WHERE member_id = $1 AND month = $2',
      [member_id, month]
    );

    if (existingPayment.rows.length > 0) {
      // Payment already exists, just update proof
      await pool.query(
        `INSERT INTO payment_proofs (member_id, month, amount, status, proof_type, proof_file_path) 
         VALUES ($1, $2, $3, 'PENDING_REVIEW', 'SCREENSHOT', $4)`,
        [member_id, month, amount, filePath]
      );

      return res.json({
        message: 'Payment proof uploaded successfully',
        status: 'PENDING_REVIEW',
        note: 'Your payment proof will be reviewed by the administrator. Payment will be verified only after confirmation from the payment provider.'
      });
    }

    // No existing payment, create proof record as PENDING
    const proof = await pool.query(
      `INSERT INTO payment_proofs (member_id, month, amount, status, proof_type, proof_file_path, transaction_id) 
       VALUES ($1, $2, $3, 'PENDING_REVIEW', 'SCREENSHOT', $4, $5) RETURNING *`,
      [member_id, month, amount, filePath, transaction_id || null]
    );

    res.json({
      message: 'Payment proof uploaded successfully',
      proof_id: proof.rows[0].id,
      status: 'PENDING_REVIEW',
      note: 'Your payment proof has been submitted for review. Payment will be verified only after:',
      verification_requirements: [
        'Administrator reviews the proof',
        'Payment provider confirms the transaction',
        'Amount matches the declared amount'
      ]
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
      `SELECT id, member_id, month, amount, proof_type, status, verification_notes, verified_by, verification_date, created_at
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

// Get pending proofs (admin only) - for manual review
router.get('/pending-proofs', authenticateToken, async (req, res) => {
  try {
    // This should be restricted to admin users
    const result = await pool.query(
      `SELECT 
        pp.id,
        pp.member_id,
        m.name as member_name,
        m.member_id as member_code,
        pp.month,
        pp.amount,
        pp.proof_type,
        pp.status,
        pp.proof_file_path,
        pp.transaction_id,
        pp.created_at
       FROM payment_proofs pp
       JOIN members m ON pp.member_id = m.id
       WHERE pp.status IN ('PENDING_REVIEW', 'PENDING')
       ORDER BY pp.created_at ASC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pending proofs:', error);
    res.status(500).json({ error: 'Failed to fetch pending proofs' });
  }
});

// Admin verifies payment proof - THIS IS THE SECURE VERIFICATION ENDPOINT
// Only mark as verified after confirming with payment provider
router.post('/verify-proof/:proof_id', authenticateToken, async (req, res) => {
  try {
    const { verified, notes, payment_provider_confirmation } = req.body;

    if (!verified) {
      return res.status(400).json({ 
        error: 'Verification status is required',
        note: 'Payment can only be marked as VERIFIED or REJECTED'
      });
    }

    if (!payment_provider_confirmation && verified === true) {
      return res.status(400).json({ 
        error: 'Payment provider confirmation required to verify payment',
        note: 'Before marking a payment as verified, ensure:',
        requirements: [
          'Confirmed with payment provider (bank, UPI, etc.)',
          'Amount matches exactly',
          'Transaction ID is valid',
          'Date matches',
          'Screenshot is not edited or forged'
        ]
      });
    }

    const newStatus = verified === true ? 'VERIFIED' : 'REJECTED';

    // Get proof details
    const proofResult = await pool.query(
      'SELECT member_id, month, amount FROM payment_proofs WHERE id = $1',
      [req.params.proof_id]
    );

    if (proofResult.rows.length === 0) {
      return res.status(404).json({ error: 'Proof not found' });
    }

    const { member_id, month, amount } = proofResult.rows[0];

    // Update proof status
    await pool.query(
      `UPDATE payment_proofs 
       SET status = $1, verification_notes = $2, verified_by = $3, verification_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [newStatus, notes || null, req.admin?.id || 1, req.params.proof_id]
    );

    // If verified, create payment record
    if (verified === true) {
      // Check if payment already exists
      const existingPayment = await pool.query(
        'SELECT id FROM monthly_payments WHERE member_id = $1 AND month = $2',
        [member_id, month]
      );

      if (existingPayment.rows.length === 0) {
        // Create verified payment record
        await pool.query(
          `INSERT INTO monthly_payments (member_id, month, payment_date, amount, status, payment_method, notes) 
           VALUES ($1, $2, CURRENT_DATE, $3, 'PAID', 'VERIFIED', $4)`,
          [member_id, month, amount, 'Verified payment proof: ' + req.params.proof_id]
        );
      }

      res.json({
        message: 'Payment verified successfully',
        status: 'VERIFIED',
        note: 'Payment marked as PAID. Monthly ₹500 credit is now eligible.'
      });
    } else {
      res.json({
        message: 'Payment rejected',
        status: 'REJECTED',
        note: notes || 'Payment proof could not be verified'
      });
    }

  } catch (error) {
    console.error('Error verifying proof:', error);
    res.status(500).json({ error: 'Failed to verify payment proof' });
  }
});

// Claim monthly ₹500 credit - ONLY after payment is verified
router.post('/claim-monthly-credit', authenticateToken, async (req, res) => {
  try {
    const { member_id, month } = req.body;

    if (!member_id || !month) {
      return res.status(400).json({ error: 'member_id and month are required' });
    }

    // CRITICAL: Check if payment for this month is VERIFIED (PAID status)
    const paymentCheck = await pool.query(
      'SELECT id FROM monthly_payments WHERE member_id = $1 AND month = $2 AND status = $3',
      [member_id, month, 'PAID']
    );

    if (paymentCheck.rows.length === 0) {
      return res.status(400).json({ 
        error: 'Payment not verified for this month',
        note: 'Monthly ₹500 credit is only available after successful payment verification',
        requirements: [
          'Payment must be completed',
          'Payment must be verified by admin',
          'Only one credit per month per member'
        ]
      });
    }

    // Check if credit already claimed for this month
    const creditCheck = await pool.query(
      'SELECT id FROM monthly_credits WHERE member_id = $1 AND month = $2',
      [member_id, month]
    );

    if (creditCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Monthly credit already claimed for this month',
        note: 'Each member can claim only one ₹500 credit per month'
      });
    }

    // Get payment ID for reference
    const paymentId = paymentCheck.rows[0].id;

    // Create monthly credit record
    const credit = await pool.query(
      `INSERT INTO monthly_credits (member_id, month, amount, status, payment_id, claimed_date) 
       VALUES ($1, $2, 500.00, 'ACTIVE', $3, CURRENT_TIMESTAMP) RETURNING *`,
      [member_id, month, paymentId]
    );

    // Update payment record with credit reference
    await pool.query(
      'UPDATE monthly_payments SET notes = $1 WHERE id = $2',
      ['Payment verified. Monthly ₹500 credit: ' + credit.rows[0].id, paymentId]
    );

    res.json({
      message: 'Monthly credit claimed successfully',
      credit_id: credit.rows[0].id,
      amount: 500.00,
      month: month,
      status: 'ACTIVE',
      note: 'You have received ₹500 credit for this month.'
    });

  } catch (error) {
    console.error('Error claiming credit:', error);
    res.status(500).json({ error: 'Failed to claim monthly credit' });
  }
});

// Get available monthly credits for a member
router.get('/monthly-credits/:member_id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        mc.id,
        mc.month,
        mc.amount,
        mc.status,
        mc.claimed_date,
        mc.created_at,
        mp.payment_date
       FROM monthly_credits mc
       LEFT JOIN monthly_payments mp ON mc.payment_id = mp.id
       WHERE mc.member_id = $1
       ORDER BY mc.month DESC`,
      [req.params.member_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching monthly credits:', error);
    res.status(500).json({ error: 'Failed to fetch monthly credits' });
  }
});

module.exports = router;
