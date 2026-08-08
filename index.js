const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const path = require('path');
require('dotenv').config();

// Import routes
const authRoutes = require('./server/routes/auth');
const membersRoutes = require('./server/routes/members');
const memberAuthRoutes = require('./server/routes/member-auth');
const memberPaymentsRoutes = require('./server/routes/member-payments');
const adminPaymentsRoutes = require('./server/routes/admin-payments');
const paymentsRoutes = require('./server/routes/Payments');
const withdrawalsRoutes = require('./server/routes/withdrawals');
const transactionsRoutes = require('./server/routes/transactions');
const dashboardRoutes = require('./server/routes/dashboard');
const importExportRoutes = require('./server/routes/import-export');
const paymentVerificationRoutes = require('./server/routes/payment-verification');

const app = express();

// Route root to Member UI directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'member-ui.html'));
});

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5000',
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(fileUpload({
  limits: { fileSize: process.env.MAX_FILE_SIZE || 10485760 },
  abortOnLimit: true,
  responseOnLimit: 'File size exceeds the maximum limit.',
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/member-auth', memberAuthRoutes);
app.use('/api/members', membersRoutes);
app.use('/api/member-payments', memberPaymentsRoutes);
app.use('/api/admin-payments', adminPaymentsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/withdrawals', withdrawalsRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/import-export', importExportRoutes);
app.use('/api/payment-verification', paymentVerificationRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS Origin: ${process.env.CORS_ORIGIN || 'http://localhost:3000'}`);
});

module.exports = app;