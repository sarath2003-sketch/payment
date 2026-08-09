const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this-in-production', (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      // Store decoded token info (works for both admin and member)
      req.admin = decoded;
      next();
    });
  } catch (error) {
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Middleware to verify only admin access
const adminOnly = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this-in-production', (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      // Check if admin (not member)
      if (decoded.type === 'member') {
        return res.status(403).json({ error: 'Admin access required' });
      }

      req.admin = decoded;
      next();
    });
  } catch (error) {
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Middleware to verify only member access
const memberOnly = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this-in-production', (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      // Check if member
      if (decoded.type !== 'member') {
        return res.status(403).json({ error: 'Member access required' });
      }

      req.admin = decoded; // Store in req.admin for consistency
      next();
    });
  } catch (error) {
    res.status(500).json({ error: 'Authentication error' });
  }
};

module.exports = { authenticateToken, adminOnly, memberOnly, requireAdmin: adminOnly };
