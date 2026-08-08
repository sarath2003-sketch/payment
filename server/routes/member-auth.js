const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * MEMBER SELF-REGISTRATION
 * Public endpoint - No authentication required
 * POST /api/member-auth/register
 */
router.post('/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, email, phone, password, confirmPassword } = req.body;

    // Validation
    if (!name || !email || !phone || !password || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Phone validation (basic)
    if (!/^\d{10}$/.test(phone.replace(/\D/g, ''))) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    await client.query('BEGIN');

    // Check if email already exists
    const emailCheck = await client.query('SELECT id FROM members WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Check if phone already exists
    const phoneCheck = await client.query('SELECT id FROM members WHERE phone = $1', [phone]);
    if (phoneCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Phone number already registered' });
    }

    // Generate unique 4-digit Member ID
    let memberId;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 100) {
      memberId = String(1000 + Math.floor(Math.random() * 9000));
      const idCheck = await client.query('SELECT id FROM members WHERE member_id = $1', [memberId]);
      isUnique = idCheck.rows.length === 0;
      attempts++;
    }

    if (!isUnique) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Could not generate unique member ID' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert member
    const result = await client.query(
      `INSERT INTO members (member_id, name, email, phone, password_hash, balance, status) 
       VALUES ($1, $2, $3, $4, $5, 0.00, 'ACTIVE') 
       RETURNING id, member_id, name, email, phone, balance, status, created_at`,
      [memberId, name, email, phone, hashedPassword]
    );

    await client.query('COMMIT');

    const member = result.rows[0];

    res.status(201).json({
      message: 'Registration successful',
      member_id: member.member_id,
      name: member.name,
      email: member.email,
      phone: member.phone,
      balance: member.balance,
      status: member.status,
      created_at: member.created_at,
      next_step: 'Use your Member ID and password to login'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

/**
 * MEMBER LOGIN
 * Public endpoint - No authentication required
 * POST /api/member-auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { member_id, password } = req.body;

    if (!member_id || !password) {
      return res.status(400).json({ error: 'Member ID and password required' });
    }

    // Find member by ID
    const result = await pool.query(
      'SELECT id, member_id, name, email, phone, password_hash, balance, status FROM members WHERE member_id = $1',
      [member_id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid member ID or password' });
    }

    const member = result.rows[0];

    // Check if account is active
    if (member.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'Account is not active' });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, member.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid member ID or password' });
    }

    // Generate JWT token
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
      balance: member.balance
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET MEMBER PROFILE
 * Requires member authentication
 * GET /api/member-auth/profile
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    if (req.admin?.type === 'admin') {
      return res.status(403).json({ error: 'Members only' });
    }

    const result = await pool.query(
      'SELECT id, member_id, name, email, phone, balance, status, created_at, updated_at FROM members WHERE id = $1',
      [req.admin.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * FORGOT PASSWORD - REQUEST OTP
 * Public endpoint
 * POST /api/member-auth/forgot-password
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }

    // Find member by phone
    const memberResult = await pool.query(
      'SELECT id, member_id, name, phone FROM members WHERE phone = $1',
      [phone]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Phone number not registered' });
    }

    const member = memberResult.rows[0];

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    // Set OTP expiry to 10 minutes
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Insert OTP
    const otpResult = await pool.query(
      `INSERT INTO member_otp (member_id, otp_code, purpose, status, expires_at) 
       VALUES ($1, $2, 'PASSWORD_RESET', 'PENDING', $3) 
       RETURNING id`,
      [member.id, otp, expiresAt]
    );

    // TODO: Send OTP via SMS (configure SMS provider)
    console.log(`[SMS] OTP for member ${member.member_id}: ${otp}`);

    res.json({
      message: 'OTP sent to your registered phone number',
      phone_hint: phone.slice(-4).padStart(10, '*'),
      otp_expires_in_minutes: 10,
      // For development/testing only - remove in production
      otp_debug: process.env.NODE_ENV === 'development' ? otp : undefined
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

/**
 * VERIFY OTP
 * Public endpoint
 * POST /api/member-auth/verify-otp
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone number and OTP required' });
    }

    // Find member and OTP
    const memberResult = await pool.query(
      'SELECT id, member_id FROM members WHERE phone = $1',
      [phone]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
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
      return res.status(400).json({ error: 'No OTP request found' });
    }

    const otpRecord = otpResult.rows[0];

    // Check if OTP has expired
    if (new Date() > new Date(otpRecord.expires_at)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // Check attempts (max 3 attempts)
    if (otpRecord.attempts >= 3) {
      return res.status(400).json({ error: 'Maximum OTP attempts exceeded. Please request a new OTP.' });
    }

    // Verify OTP
    if (otpRecord.otp_code !== otp) {
      // Increment attempts
      await pool.query(
        'UPDATE member_otp SET attempts = attempts + 1 WHERE id = $1',
        [otpRecord.id]
      );
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // Mark OTP as verified
    await pool.query(
      "UPDATE member_otp SET status = 'VERIFIED' WHERE id = $1",
      [otpRecord.id]
    );

    // Generate a temporary token for password reset
    const resetToken = jwt.sign(
      { member_id: member.id, type: 'password_reset' },
      process.env.JWT_SECRET || 'your-secret-key-change-this-in-production',
      { expiresIn: '15m' }
    );

    res.json({
      message: 'OTP verified',
      reset_token: resetToken,
      next_step: 'Use this token to set your new password'
    });

  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

/**
 * RESET PASSWORD
 * Uses reset token from OTP verification
 * POST /api/member-auth/reset-password
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { reset_token, new_password, confirm_password } = req.body;

    if (!reset_token || !new_password || !confirm_password) {
      return res.status(400).json({ error: 'All fields required' });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Verify reset token
    let decoded;
    try {
      decoded = jwt.verify(
        reset_token,
        process.env.JWT_SECRET || 'your-secret-key-change-this-in-production'
      );
    } catch (error) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    if (decoded.type !== 'password_reset') {
      return res.status(400).json({ error: 'Invalid token type' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Update password
    const result = await pool.query(
      'UPDATE members SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING member_id',
      [hashedPassword, decoded.member_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({
      message: 'Password reset successful',
      member_id: result.rows[0].member_id,
      next_step: 'Login with your new password'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

/**
 * LOGOUT
 * POST /api/member-auth/logout
 */
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
