const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// GET /api/settings/public — Public settings (logo, QR, org name, WhatsApp)
// ============================================================
router.get('/public', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT key, value FROM app_settings
      WHERE key IN ('org_name','org_name_tamil','logo_path','qr_path','admin_upi_id','admin_upi_name','whatsapp_link','default_payment_amount','payment_instructions_en','payment_instructions_ta')
    `);
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error('Error fetching public settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ============================================================
// GET /api/settings — Admin: All settings
// ============================================================
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM app_settings ORDER BY key');
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ============================================================
// PUT /api/settings — Admin: Update settings (key-value pairs)
// ============================================================
router.put('/', authenticateToken, requireAdmin, async (req, res) => {
  const allowed = [
    'org_name', 'org_name_tamil', 'whatsapp_link', 'default_payment_amount',
    'payment_instructions_en', 'payment_instructions_ta',
    'admin_upi_id', 'admin_upi_name', 'qr_path',
    'auction_default_duration', 'auction_default_starting_amount', 'auction_default_bid_increment',
    'notifications_enabled', 'sound_enabled'
  ];
  try {
    const updates = req.body;
    const keys = Object.keys(updates).filter(k => allowed.includes(k));
    if (keys.length === 0) return res.status(400).json({ error: 'No valid settings provided' });

    for (const key of keys) {
      await pool.query(`
        INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
      `, [key, String(updates[key])]);
    }
    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ============================================================
// POST /api/settings/upload-qr — Admin: Upload QR Code Image
// ============================================================
router.post('/upload-qr', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let qrUrl = '';
    if (req.body && req.body.image_data) {
      const base64Data = req.body.image_data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = `qr_${Date.now()}.png`;
      const uploadsDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, buffer);
      qrUrl = `/uploads/${filename}`;
    } else if (req.files && (req.files.qr || req.files.qr_code || req.files.image)) {
      const file = req.files.qr || req.files.qr_code || req.files.image;
      const ext = path.extname(file.name) || '.png';
      const filename = `qr_${Date.now()}${ext}`;
      const uploadsDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const filePath = path.join(uploadsDir, filename);
      await file.mv(filePath);
      qrUrl = `/uploads/${filename}`;
    } else {
      return res.status(400).json({ error: 'No image provided for QR code.' });
    }

    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at) VALUES ('qr_path', $1, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP
    `, [qrUrl]);

    res.json({ message: 'QR Code uploaded successfully!', qr_path: qrUrl });
  } catch (err) {
    console.error('Error uploading QR code:', err);
    res.status(500).json({ error: err.message || 'Failed to upload QR code' });
  }
});

// ============================================================
// POST /api/settings/logo — Admin: Upload org logo
// ============================================================
router.post('/logo', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!req.files || !req.files.logo) {
      return res.status(400).json({ error: 'No logo file uploaded' });
    }
    const logoFile = req.files.logo;
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
    if (!allowedTypes.includes(logoFile.mimetype)) {
      return res.status(400).json({ error: 'Logo must be an image file (JPG, PNG, WebP, SVG)' });
    }
    if (logoFile.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Logo must be under 5MB' });
    }

    const assetsDir = path.join(__dirname, '..', '..', 'public', 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const ext = path.extname(logoFile.name) || '.png';
    const logoName = `logo_${Date.now()}${ext}`;
    const logoPath = path.join(assetsDir, logoName);
    await logoFile.mv(logoPath);

    const logoUrl = `/assets/${logoName}`;
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('logo_path', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [logoUrl]
    );

    res.json({ message: 'Logo uploaded successfully', logo_path: logoUrl });
  } catch (err) {
    console.error('Error uploading logo:', err);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// ============================================================
// POST /api/settings/qr — Admin: Upload payment QR code
// ============================================================
router.post('/qr', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!req.files || !req.files.qr) {
      return res.status(400).json({ error: 'No QR file uploaded' });
    }
    const qrFile = req.files.qr;
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(qrFile.mimetype)) {
      return res.status(400).json({ error: 'QR must be an image file (JPG, PNG, WebP)' });
    }
    if (qrFile.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'QR image must be under 5MB' });
    }

    const assetsDir = path.join(__dirname, '..', '..', 'public', 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const ext = path.extname(qrFile.name) || '.png';
    const qrName = `qr_${Date.now()}${ext}`;
    const qrPath = path.join(assetsDir, qrName);
    await qrFile.mv(qrPath);

    const qrUrl = `/assets/${qrName}`;
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('qr_path', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [qrUrl]
    );

    res.json({ message: 'QR code uploaded successfully', qr_path: qrUrl });
  } catch (err) {
    console.error('Error uploading QR:', err);
    res.status(500).json({ error: 'Failed to upload QR code' });
  }
});

// ============================================================
// DELETE /api/settings/logo — Admin: Remove logo
// ============================================================
router.delete('/logo', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE app_settings SET value = NULL WHERE key = 'logo_path'`);
    res.json({ message: 'Logo removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove logo' });
  }
});

// ============================================================
// DELETE /api/settings/qr — Admin: Remove QR
// ============================================================
router.delete('/qr', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE app_settings SET value = NULL WHERE key = 'qr_path'`);
    res.json({ message: 'QR code removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove QR' });
  }
});

module.exports = router;
