const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // For development/demo: simple authentication against environment variables
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123456';

    if (username === adminUsername && password === adminPassword) {
      const token = jwt.sign(
        { id: 1, username: username, type: 'admin' },
        process.env.JWT_SECRET || 'your-secret-key-change-this-in-production',
        { expiresIn: process.env.JWT_EXPIRATION || '24h' }
      );

      // Update last login
      try {
        await pool.query(
          'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE username = $1',
          [username]
        );
      } catch (dbError) {
        console.warn('Could not update last login:', dbError.message);
        // Don't fail login if database update fails
      }

      return res.json({ 
        token, 
        username,
        message: 'Login successful'
      });
    }

    res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify token
router.get('/verify', authenticateToken, (req, res) => {
  res.json({ 
    valid: true, 
    admin: req.admin 
  });
});

// Logout
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ 
    message: 'Logged out successfully' 
  });
});

module.exports = router;