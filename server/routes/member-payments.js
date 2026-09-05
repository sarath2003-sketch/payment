const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { verifyPaymentRules, executePaymentApproval } = require('../services/payment-verifier');

const router = express.Router();

/**
 * UPLOAD PAYMENT PROOF
 * Member uploads payment screenshot/proof
 * POST /api/member-payments/upload
 */
router.post('/upload', authenticateToken, async (req, res) => {
  try {
    if (!req.files || !req.files.proof) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { amount, transaction_reference, payment_date } = req.body;
    const memberId = req.admin?.id;

    if (!memberId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!amount || !transaction_reference || !payment_date) {
      return res.status(400).json({ error: 'amount, transaction_reference, and payment_date are required' });
    }

    const proofFile = req.files.proof;

    // Validate file type
    const allowedMimes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedMimes.includes(proofFile.mimetype)) {
      return res.status(400).json({ 
        error: 'Only JPG, PNG, and PDF files are allowed' 
      });
    }

    // Validate file size (max 5MB)
    if (proofFile.size > 5 * 1024 * 1024) {
      return res.status(400).json({ 
        error: 'File size must be less than 5MB' 
      });
    }

    // Validate amount
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Create uploads directory if needed
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Generate secure filename
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(proofFile.name);
    const fileName = `proof_${memberId}_${timestamp}_${randomStr}${ext}`;
    const filePath = path.join(uploadDir, fileName);
    const webPath = `/uploads/${fileName}`;

    // Save file
    await proofFile.mv(filePath);

    // Run Amount Auto-Verification Rules
    const verification = await verifyPaymentRules({
      member_id: memberId,
      amount: amountNum,
      transaction_reference
    });

    const isAutoApproved = verification.autoApprove;
    const initialStatus = isAutoApproved ? 'APPROVED' : 'PENDING';
    const flagReason = !isAutoApproved ? verification.reason : null;

    // Insert payment proof record
    const result = await pool.query(
      `INSERT INTO payment_proofs (
        member_id, amount, transaction_reference, payment_date, 
        proof_file_path, proof_file_name, status, rejection_reason,
        verified_at, verified_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${isAutoApproved ? 'CURRENT_TIMESTAMP' : 'NULL'}, ${isAutoApproved ? '1' : 'NULL'})
      RETURNING id, member_id, amount, transaction_reference, payment_date, status, created_at`,
      [memberId, amountNum, transaction_reference, payment_date, webPath, fileName, initialStatus, flagReason]
    );

    const proof = result.rows[0];
    const io = req.app.get('io');

    if (isAutoApproved) {
      await executePaymentApproval({
        payment_id: proof.id,
        member_id: memberId,
        amount: amountNum,
        transaction_reference,
        payment_date,
        verified_by: 1,
        io
      });
    } else {
      if (io) {
        io.emit('payment:new-proof', { proof });
        io.emit('notification:broadcast', {
          title: '💳 New Payment Proof Uploaded',
          body: `Payment proof submitted for Member ID ${memberId} (Amount: ₹${amountNum}) - queued for admin review.`
        });
      }
    }

    res.json({
      message: isAutoApproved 
        ? 'Payment auto-verified and ₹500 credited to your account!' 
        : 'Payment proof uploaded successfully',
      proof_id: proof.id,
      amount: proof.amount,
      transaction_reference: proof.transaction_reference,
      payment_date: proof.payment_date,
      status: isAutoApproved ? 'APPROVED' : 'PENDING',
      auto_approved: isAutoApproved,
      created_at: proof.created_at,
      note: isAutoApproved 
        ? 'Your monthly contribution has been auto-verified and credited immediately.' 
        : (flagReason || 'Your payment is pending verification by admin.')
    });

  } catch (error) {
    console.error('Error uploading payment proof:', error);
    res.status(500).json({ error: 'Failed to upload payment proof' });
  }
});

/**
 * GET MEMBER'S PAYMENT PROOFS
 * GET /api/member-payments/my-proofs
 */
router.get('/my-proofs', authenticateToken, async (req, res) => {
  try {
    const memberId = req.admin?.id;

    if (!memberId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await pool.query(
      `SELECT 
        id, member_id, amount, transaction_reference, payment_date, 
        status, rejection_reason, verified_at, created_at
       FROM payment_proofs 
       WHERE member_id = $1
       ORDER BY created_at DESC`,
      [memberId]
    );

    res.json({
      proofs: result.rows,
      total: result.rows.length,
      pending: result.rows.filter(p => p.status === 'PENDING').length,
      approved: result.rows.filter(p => p.status === 'APPROVED').length,
      rejected: result.rows.filter(p => p.status === 'REJECTED').length
    });

  } catch (error) {
    console.error('Error fetching payment proofs:', error);
    res.status(500).json({ error: 'Failed to fetch payment proofs' });
  }
});

/**
 * GET MEMBER'S TRANSACTION HISTORY
 * GET /api/member-payments/history
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const memberId = req.admin?.id;

    if (!memberId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await pool.query(
      `SELECT 
        id, member_id, amount, transaction_reference, payment_date, 
        status, verified_at, created_at
       FROM payment_proofs 
       WHERE member_id = $1 AND status = 'APPROVED'
       ORDER BY verified_at DESC`,
      [memberId]
    );

    const totalApproved = result.rows.reduce((sum, row) => sum + parseFloat(row.amount), 0);

    res.json({
      transactions: result.rows,
      total_transactions: result.rows.length,
      total_amount_approved: totalApproved
    });

  } catch (error) {
    console.error('Error fetching transaction history:', error);
    res.status(500).json({ error: 'Failed to fetch transaction history' });
  }
});

/**
 * GET MEMBER BALANCE
 * GET /api/member-payments/balance
 */
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const memberId = req.admin?.id;

    if (!memberId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await pool.query(
      'SELECT id, member_id, balance FROM members WHERE id = $1',
      [memberId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({
      member_id: result.rows[0].member_id,
      balance: result.rows[0].balance
    });

  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

module.exports = router;
