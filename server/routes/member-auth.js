const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * MEMBER SELF-REGISTRATION
 * Public endpoint - No authentication required
 * POST /api/member-auth/register or POST /member-auth/register
 */
router.post(['/', '/register'], async (req, res) => {
  console.log('--- New Registration Request ---');
  let client;
  try {
    let { name, email, phone, password, confirmPassword } = req.body || {};

    // Sanitize & Trim
    name = (name || '').trim();
    email = (email || '').trim().toLowerCase();
    
    let rawPhone = (phone || '').trim();
    let cleanPhone = rawPhone.replace(/\D/g, '');

    // Allow taking last 10 digits if country code included (e.g. +91 9025893352 -> 9025893352)
    if (cleanPhone.length > 10) {
      cleanPhone = cleanPhone.slice(-10);
    }
    
    password = password || '';
    confirmPassword = confirmPassword || '';

    // Validation
    if (!name || !email || !cleanPhone || !password || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Phone format validation (10 digits)
    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit phone number.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if email already exists
    const emailCheck = await client.query('SELECT id FROM members WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email is already registered. Please login or use another email.' });
    }

    // Check if phone already exists
    const phoneCheck = await client.query('SELECT id FROM members WHERE phone = $1', [cleanPhone]);
    if (phoneCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Phone number is already registered. Please login or use another phone number.' });
    }

    // Check for potential duplicate matching by Name or UPI
    let upiId = (req.body.upi_id || '').trim();
    let isDuplicate = false;
    let duplicateReason = null;
    let duplicateOfId = null;

    const dupCheck = await client.query(
      `SELECT id, member_id, name FROM members 
       WHERE LOWER(name) = LOWER($1) OR (upi_id IS NOT NULL AND upi_id != '' AND LOWER(upi_id) = LOWER($2))`,
      [name, upiId]
    );

    if (dupCheck.rows.length > 0) {
      isDuplicate = true;
      duplicateOfId = dupCheck.rows[0].id;
      duplicateReason = `Similar name/UPI matching existing member ${dupCheck.rows[0].member_id} (${dupCheck.rows[0].name})`;
    }

    // Generate next sequential Member ID starting at 101
    const idRes = await client.query(`
      SELECT member_id FROM members 
      WHERE deleted_at IS NULL
      ORDER BY id DESC
    `);
    
    let maxNum = 100;
    for (const row of idRes.rows || []) {
      const num = parseInt(row.member_id, 10);
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
    const memberId = String(maxNum + 1);

    // Hash password securely
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new member
    const result = await client.query(
      `INSERT INTO members 
        (member_id, name, email, phone, upi_id, password_hash, balance, status, activation_status, payment_status, is_duplicate, duplicate_reason, duplicate_of_id) 
       VALUES ($1, $2, $3, $4, $5, $6, 0.00, 'ACTIVE', 'PENDING', 'UNPAID', $7, $8, $9) 
       RETURNING id, member_id, name, email, phone, upi_id, balance, status, activation_status, payment_status, created_at`,
      [memberId, name, email, cleanPhone, upiId || null, hashedPassword, isDuplicate, duplicateReason, duplicateOfId]
    );

    await client.query('COMMIT');

    const member = result.rows[0];
    console.log(`[REGISTRATION SUCCESS] Member ID: ${member.member_id}, Email: ${member.email}`);

    // Generate JWT token for instant login
    const token = jwt.sign(
      { 
        id: member.id, 
        member_id: member.member_id, 
        type: 'member'
      },
      process.env.JWT_SECRET || 'your-secret-key-change-this-in-production',
      { expiresIn: process.env.JWT_EXPIRATION || '24h' }
    );

    res.status(201).json({
      message: 'Registration successful!',
      token: token,
      member_id: member.member_id,
      name: member.name,
      email: member.email,
    });

  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Registration server error:', error);
    res.status(500).json({ error: error.message || 'Registration failed due to a server error.' });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * MEMBER LOGIN
 * Public endpoint - No authentication required
 * POST /api/member-auth/login or POST /member-auth/login
 */
router.post(['/login', '/login/'], async (req, res) => {
  try {
    let { member_id, password } = req.body || {};
    member_id = (member_id || '').trim();
    password = password || '';

    if (!member_id || !password) {
      return res.status(400).json({ error: 'Member ID and password are required.' });
    }

    // Find member by member_id, email, or phone
    let cleanPhone = member_id.replace(/\D/g, '');
    if (cleanPhone.length > 10) cleanPhone = cleanPhone.slice(-10);

    const result = await pool.query(
      'SELECT id, member_id, name, email, phone, password_hash, balance, status FROM members WHERE member_id = $1 OR email = $1 OR (phone = $2 AND $2 != \'\')',
      [member_id, cleanPhone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid Member ID, Email, or Password.' });
    }

    const member = result.rows[0];

    if (member.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'Your account is currently inactive. Please contact support.' });
    }

    const passwordMatch = await bcrypt.compare(password, member.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid Member ID, Email, or Password.' });
    }

    const token = jwt.sign(
      { 
        id: member.id, 
        member_id: member.member_id, 
        type: 'member'
      },
      process.env.JWT_SECRET || 'your-secret-key-change-this-in-production',
      { expiresIn: process.env.JWT_EXPIRATION || '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      member_id: member.member_id,
      name: member.name,
      email: member.email,
      balance: parseFloat(member.balance)
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed due to a server error.' });
  }
});

/**
 * GET MEMBER PROFILE
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    if (req.admin?.type === 'admin') {
      return res.status(403).json({ error: 'Members only' });
    }

    const memberId = req.admin.id;

    const memberResult = await pool.query(
      'SELECT id, member_id, name, email, phone, upi_id, balance, status, activation_status, payment_status, is_duplicate, group_category, created_at, updated_at FROM members WHERE id = $1',
      [memberId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const member = memberResult.rows[0];

    const statsResult = await pool.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN amount ELSE 0 END), 0) AS total_paid,
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END) AS pending_count,
        COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) AS approved_count
       FROM payment_proofs
       WHERE member_id = $1`,
      [memberId]
    );

    const stats = statsResult.rows[0];
    member.balance = parseFloat(member.balance);
    member.total_paid = parseFloat(stats.total_paid);
    member.pending_count = parseInt(stats.pending_count);
    member.approved_count = parseInt(stats.approved_count);

    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    const currentMonthPaymentResult = await pool.query(
      `SELECT status 
       FROM payment_proofs
       WHERE member_id = $1 AND TO_CHAR(payment_date, 'YYYY-MM') = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [memberId, currentMonthStr]
    );

    if (currentMonthPaymentResult.rows.length > 0) {
      member.current_month_payment_status = currentMonthPaymentResult.rows[0].status;
    } else {
      member.current_month_payment_status = 'NOT_PAID';
    }

    res.json(member);

  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * FORGOT PASSWORD - REQUEST OTP
 */
router.post('/forgot-password', async (req, res) => {
  try {
    let { phone } = req.body || {};
    let cleanPhone = (phone || '').trim().replace(/\D/g, '');
    if (cleanPhone.length > 10) cleanPhone = cleanPhone.slice(-10);

    if (!cleanPhone) {
      return res.status(400).json({ error: 'Phone number is required.' });
    }

    const memberResult = await pool.query(
      'SELECT id, member_id, name, phone FROM members WHERE phone = $1',
      [cleanPhone]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Phone number not registered.' });
    }

    const member = memberResult.rows[0];
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO member_otp (member_id, otp_code, purpose, status, expires_at) 
       VALUES ($1, $2, 'PASSWORD_RESET', 'PENDING', $3)`,
      [member.id, otp, expiresAt]
    );

    console.log(`[SMS OTP] Member ID: ${member.member_id}, OTP: ${otp}`);

    res.json({
      message: 'OTP sent to your registered phone number.',
      otp_expires_in_minutes: 10,
      otp_debug: process.env.NODE_ENV === 'development' ? otp : undefined
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password reset request.' });
  }
});

/**
 * VERIFY OTP
 */
router.post('/verify-otp', async (req, res) => {
  try {
    let { phone, otp } = req.body || {};
    let cleanPhone = (phone || '').trim().replace(/\D/g, '');
    if (cleanPhone.length > 10) cleanPhone = cleanPhone.slice(-10);
    otp = (otp || '').trim();

    if (!cleanPhone || !otp) {
      return res.status(400).json({ error: 'Phone number and OTP are required.' });
    }

    const memberResult = await pool.query(
      'SELECT id, member_id FROM members WHERE phone = $1',
      [cleanPhone]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    const member = memberResult.rows[0];

    const otpResult = await pool.query(
      `SELECT id, otp_code, status, attempts, expires_at 
       FROM member_otp 
       WHERE member_id = $1 AND purpose = 'PASSWORD_RESET' 
       ORDER BY created_at DESC LIMIT 1`,
      [member.id]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'No OTP request found.' });
    }

    const otpRecord = otpResult.rows[0];

    if (new Date() > new Date(otpRecord.expires_at)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    if (otpRecord.attempts >= 3) {
      return res.status(400).json({ error: 'Maximum OTP attempts exceeded. Please request a new OTP.' });
    }

    if (otpRecord.otp_code !== otp) {
      await pool.query(
        'UPDATE member_otp SET attempts = attempts + 1 WHERE id = $1',
        [otpRecord.id]
      );
      return res.status(400).json({ error: 'Invalid OTP.' });
    }

    await pool.query(
      "UPDATE member_otp SET status = 'VERIFIED' WHERE id = $1",
      [otpRecord.id]
    );

    const resetToken = jwt.sign(
      { member_id: member.id, type: 'password_reset' },
      process.env.JWT_SECRET || 'your-secret-key-change-this-in-production',
      { expiresIn: '15m' }
    );

    res.json({
      message: 'OTP verified successfully.',
      reset_token: resetToken
    });

  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({ error: 'OTP verification failed.' });
  }
});

/**
 * RESET PASSWORD
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { reset_token, new_password, confirm_password } = req.body || {};

    if (!reset_token || !new_password || !confirm_password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(
        reset_token,
        process.env.JWT_SECRET || 'your-secret-key-change-this-in-production'
      );
    } catch (error) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }

    if (decoded.type !== 'password_reset') {
      return res.status(400).json({ error: 'Invalid token type.' });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);

    const result = await pool.query(
      'UPDATE members SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING member_id',
      [hashedPassword, decoded.member_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    res.json({
      message: 'Password reset successful.',
      member_id: result.rows[0].member_id
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed.' });
  }
});

/**
 * LOGOUT
 */
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
