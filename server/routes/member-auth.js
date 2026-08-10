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

    // Smart Email Auto-formatting
    if (!email) {
      email = `member_${cleanPhone}@pfchitfund.com`;
    } else if (!email.includes('@')) {
      email = `${email}@gmail.com`;
    } else if (!email.includes('.')) {
      email = `${email}.com`;
    }

    // Validation
    if (!name || !cleanPhone || !password || !confirmPassword) {
      return res.status(400).json({ error: 'Name, phone number, and password are required.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    // Phone format validation (10 digits)
    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit phone number.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if phone already exists
    const phoneCheck = await client.query('SELECT id, member_id, name FROM members WHERE phone = $1', [cleanPhone]);
    if (phoneCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      const existingId = phoneCheck.rows[0]?.member_id || phoneCheck.rows[0]?.id || '';
      return res.status(400).json({ error: `Phone number ${cleanPhone} is already registered to Member ID ${existingId}. Please login with your password.` });
    }

    // Auto-resolve duplicate email by appending unique suffix if needed
    const emailCheck = await client.query('SELECT id FROM members WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) {
      email = `${email.split('@')[0]}_${cleanPhone}@${email.split('@')[1] || 'gmail.com'}`;
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
      duplicateOfId = dupCheck.rows[0]?.id || null;
      const dupMemberId = dupCheck.rows[0]?.member_id || dupCheck.rows[0]?.id || '';
      const dupName = dupCheck.rows[0]?.name || '';
      duplicateReason = `Similar name/UPI matching existing member ${dupMemberId} (${dupName})`;
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
       VALUES ($1, $2, $3, $4, $5, $6, 0.00, 'ACTIVE', 'ACTIVE', 'UNPAID', $7, $8, $9) 
       RETURNING id, member_id, name, email, phone, upi_id, balance, status, activation_status, payment_status, created_at`,
      [memberId, name, email, cleanPhone, upiId || null, hashedPassword, isDuplicate, duplicateReason, duplicateOfId]
    );

    await client.query('COMMIT');

    const member = result.rows[0] || {};
    const finalMemberId = member.member_id || memberId;
    const finalName = member.name || name;
    const finalEmail = member.email || email;
    const finalId = member.id || 0;

    console.log(`[REGISTRATION SUCCESS] Member ID: ${finalMemberId}, Email: ${finalEmail}`);

    // Generate JWT token for instant login
    const token = jwt.sign(
      { 
        id: finalId, 
        member_id: finalMemberId, 
        type: 'member'
      },
      process.env.JWT_SECRET || 'your-secret-key-change-this-in-production',
      { expiresIn: process.env.JWT_EXPIRATION || '24h' }
    );

    res.status(201).json({
      message: 'Registration successful!',
      token: token,
      member_id: finalMemberId,
      name: finalName,
      email: finalEmail,
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
      return res.status(400).json({ error: 'Member ID, Phone, or Email and password are required.' });
    }

    // Find member by member_id, email, or phone
    let cleanPhone = member_id.replace(/\D/g, '');
    if (cleanPhone.length > 10) cleanPhone = cleanPhone.slice(-10);

    const result = await pool.query(
      `SELECT id, member_id, name, email, phone, password_hash, balance, status, activation_status 
       FROM members 
       WHERE LOWER(member_id) = LOWER($1) OR LOWER(email) = LOWER($1) OR (phone = $2 AND $2 != '')`,
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
      'SELECT id, member_id, name, email, phone, upi_id, profile_photo, balance, status, activation_status, payment_status, is_duplicate, group_category, created_at, updated_at FROM members WHERE id = $1',
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

    const stats = statsResult.rows[0] || { total_paid: 0, pending_count: 0, approved_count: 0 };
    member.balance = parseFloat(member.balance || 0);
    member.total_paid = parseFloat(stats.total_paid || 0);
    member.pending_count = parseInt(stats.pending_count || 0);
    member.approved_count = parseInt(stats.approved_count || 0);

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
 * PUT /api/member-auth/profile
 * Member updates their own name, email, upi_id, profile_photo
 */
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const memberId = req.admin.id;
    let { name, email, upi_id, profile_photo } = req.body || {};

    const existingRes = await pool.query('SELECT * FROM members WHERE id = $1', [memberId]);
    if (existingRes.rows.length === 0) return res.status(404).json({ error: 'Member not found' });
    const existing = existingRes.rows[0];

    name = (name !== undefined && name !== null) ? String(name).trim() : existing.name;
    email = (email !== undefined && email !== null) ? String(email).trim().toLowerCase() : existing.email;
    upi_id = (upi_id !== undefined && upi_id !== null) ? String(upi_id).trim() : existing.upi_id;
    profile_photo = (profile_photo !== undefined && profile_photo !== null) ? String(profile_photo).trim() : existing.profile_photo;

    const result = await pool.query(
      `UPDATE members 
       SET name = $1, email = $2, upi_id = $3, profile_photo = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, member_id, name, email, phone, upi_id, profile_photo, balance, status, activation_status, payment_status`,
      [name, email, upi_id || null, profile_photo || null, memberId]
    );

    res.json({ message: 'Profile updated successfully!', member: result.rows[0] });
  } catch (error) {
    console.error('Error updating member profile:', error);
    res.status(500).json({ error: error.message || 'Failed to update profile' });
  }
});

/**
 * POST /api/member-auth/profile-photo
 * Upload profile photo for logged-in member (Base64 data or Multipart)
 */
router.post('/profile-photo', authenticateToken, async (req, res) => {
  try {
    const memberId = req.admin.id;
    const fs = require('fs');
    const path = require('path');

    let photoUrl = '';

    if (req.body && req.body.image_data) {
      // Base64 Data URL upload
      const base64Data = req.body.image_data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = `profile_${memberId}_${Date.now()}.png`;
      const uploadsDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, buffer);
      photoUrl = `/uploads/${filename}`;
    } else if (req.files && (req.files.photo || req.files.profile_photo || req.files.image)) {
      const file = req.files.photo || req.files.profile_photo || req.files.image;
      const ext = path.extname(file.name) || '.png';
      const filename = `profile_${memberId}_${Date.now()}${ext}`;
      const uploadsDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const filePath = path.join(uploadsDir, filename);
      await file.mv(filePath);
      photoUrl = `/uploads/${filename}`;
    } else {
      return res.status(400).json({ error: 'No image file or image_data provided.' });
    }

    await pool.query('UPDATE members SET profile_photo = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [photoUrl, memberId]);
    res.json({ message: 'Profile photo uploaded successfully!', profile_photo: photoUrl });
  } catch (error) {
    console.error('Error uploading profile photo:', error);
    res.status(500).json({ error: error.message || 'Failed to upload profile photo' });
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
 * UPDATE MEMBER PROFILE (Name, Email, UPI ID)
 */
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    if (req.admin?.type === 'admin') {
      return res.status(403).json({ error: 'Members only' });
    }
    const memberId = req.admin.id;
    let { name, email, upi_id } = req.body || {};

    name = (name !== undefined) ? name.trim() : null;
    email = (email !== undefined) ? email.trim().toLowerCase() : null;
    upi_id = (upi_id !== undefined) ? upi_id.trim() : null;

    const existingRes = await pool.query('SELECT * FROM members WHERE id = $1', [memberId]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const existing = existingRes.rows[0];

    const newName = name || existing.name;
    const newEmail = email || existing.email;
    const newUpi = (upi_id !== null) ? upi_id : existing.upi_id;

    const updateRes = await pool.query(
      `UPDATE members 
       SET name = $1, email = $2, upi_id = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING id, member_id, name, email, phone, upi_id, balance, status, activation_status, payment_status`,
      [newName, newEmail, newUpi || null, memberId]
    );

    res.json({ message: 'Profile updated successfully', member: updateRes.rows[0] });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * CHANGE PASSWORD (Old Password -> New Password)
 */
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    if (req.admin?.type === 'admin') {
      return res.status(403).json({ error: 'Members only' });
    }
    const memberId = req.admin.id;
    const { old_password, new_password, confirm_password } = req.body || {};

    if (!old_password || !new_password || !confirm_password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ error: 'New passwords do not match.' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }

    const memberRes = await pool.query('SELECT id, password_hash FROM members WHERE id = $1', [memberId]);
    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    const member = memberRes.rows[0];
    const isOldMatch = await bcrypt.compare(old_password, member.password_hash);
    if (!isOldMatch) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE members SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newHash, memberId]);

    res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

/**
 * LOGOUT
 */
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
