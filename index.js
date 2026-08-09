const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const pool = require('./server/config/database');

// Import routes
const authRoutes = require('./server/routes/auth');
const membersRoutes = require('./server/routes/members');
const memberAuthRoutes = require('./server/routes/member-auth');
const memberPaymentsRoutes = require('./server/routes/member-payments');
const adminPaymentsRoutes = require('./server/routes/admin-payments');
const paymentsRoutes = require('./server/routes/payments');
const withdrawalsRoutes = require('./server/routes/withdrawals');
const transactionsRoutes = require('./server/routes/transactions');
const dashboardRoutes = require('./server/routes/dashboard');
const importExportRoutes = require('./server/routes/import-export');
const paymentVerificationRoutes = require('./server/routes/payment-verification');
const monthlyPaymentsRoutes = require('./server/routes/monthly-payments');
const auctionRoutes = require('./server/routes/auction');
const chatRoutes = require('./server/routes/chat');
const notificationsRoutes = require('./server/routes/notifications');
const settingsRoutes = require('./server/routes/settings');
const adminMembersRoutes = require('./server/routes/admin-members');
const adminPaymentsNewRoutes = require('./server/routes/admin-payments');
const auditLogsRoutes = require('./server/routes/audit-logs');
const { endAuction } = require('./server/routes/auction');

const app = express();
const server = http.createServer(app);

// ============================================================
// Socket.IO Setup
// ============================================================
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.set('io', io);

// ============================================================
// Auction Timer Manager — Server-side countdown
// ============================================================
const auctionTimers = {};

const auctionTimerManager = {
  startTimer(auctionId, ioInstance) {
    if (auctionTimers[auctionId]) {
      clearInterval(auctionTimers[auctionId]);
    }
    auctionTimers[auctionId] = setInterval(async () => {
      try {
        const result = await pool.query(
          "SELECT * FROM auctions WHERE id = $1 AND status = 'LIVE'",
          [auctionId]
        );
        if (result.rows.length === 0) {
          clearInterval(auctionTimers[auctionId]);
          delete auctionTimers[auctionId];
          return;
        }
        const auction = result.rows[0];
        const elapsed = (auction.elapsed_seconds || 0) + Math.floor((Date.now() - new Date(auction.timer_started_at).getTime()) / 1000);
        const remaining = Math.max(0, auction.duration_seconds - elapsed);

        ioInstance.to(`auction_${auctionId}`).emit('auction:timer-tick', {
          remaining_seconds: remaining,
          auction_id: auctionId,
          status: 'LIVE'
        });

        if (remaining <= 0) {
          clearInterval(auctionTimers[auctionId]);
          delete auctionTimers[auctionId];
          // End auction
          try {
            await endAuction(auctionId, ioInstance, pool);
          } catch (e) {
            console.error('Auto-end auction error:', e.message);
          }
        }
      } catch (err) {
        console.error('Timer tick error:', err.message);
      }
    }, 1000);
  },
  stopTimer(auctionId) {
    if (auctionTimers[auctionId]) {
      clearInterval(auctionTimers[auctionId]);
      delete auctionTimers[auctionId];
    }
  }
};

app.set('auctionTimerManager', auctionTimerManager);

// ============================================================
// Socket.IO Authentication + Events
// ============================================================
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    // Allow unauthenticated for read-only listeners
    socket.user = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this-in-production');
    socket.user = decoded;
    next();
  } catch (err) {
    socket.user = null;
    next();
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id} | User: ${socket.user?.member_id || socket.user?.username || 'guest'}`);

  // Join auction room
  socket.on('join-auction', ({ auction_id }) => {
    if (auction_id) {
      socket.join(`auction_${auction_id}`);
      console.log(`[Socket.IO] ${socket.id} joined auction_${auction_id}`);
      socket.emit('joined-auction', { auction_id });
    }
  });

  // Leave auction room
  socket.on('leave-auction', ({ auction_id }) => {
    socket.leave(`auction_${auction_id}`);
  });

  // Send chat message via socket
  socket.on('send-chat', async ({ auction_id, message }) => {
    if (!socket.user || !message || !auction_id) return;
    if (message.trim().length === 0 || message.length > 500) return;

    try {
      // Rate limit: max 1 message per second
      const now = Date.now();
      const lastMsg = socket.lastChatTime || 0;
      if (now - lastMsg < 1000) {
        socket.emit('chat-error', { error: 'Sending too fast. Please wait.' });
        return;
      }
      socket.lastChatTime = now;

      // Check mute status
      if (socket.user.type === 'member') {
        const muteCheck = await pool.query(`
          SELECT id FROM muted_members
          WHERE auction_id = $1 AND member_id = $2 AND (muted_until IS NULL OR muted_until > CURRENT_TIMESTAMP)
        `, [auction_id, socket.user.id]);
        if (muteCheck.rows.length > 0) {
          socket.emit('chat-error', { error: 'You have been muted in this auction' });
          return;
        }
      }

      let senderName, senderMemberId, memberId = null, adminId = null;
      if (socket.user.type === 'admin') {
        adminId = socket.user.id;
        senderName = 'Admin';
        senderMemberId = 'ADMIN';
      } else {
        memberId = socket.user.id;
        const member = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
        senderName = member.rows[0]?.name || 'Member';
        senderMemberId = member.rows[0]?.member_id || '';
      }

      const result = await pool.query(`
        INSERT INTO auction_chat_messages (auction_id, member_id, admin_id, sender_name, sender_member_id, message, message_type)
        VALUES ($1, $2, $3, $4, $5, $6, 'text') RETURNING *
      `, [auction_id, memberId, adminId, senderName, senderMemberId, message.trim()]);

      const msgData = {
        id: result.rows[0].id,
        sender_name: senderName,
        sender_member_id: senderMemberId,
        message: message.trim(),
        message_type: 'text',
        created_at: result.rows[0].created_at,
        sender_role: adminId ? 'admin' : 'member'
      };

      io.to(`auction_${auction_id}`).emit('auction:new-chat', msgData);
    } catch (err) {
      console.error('Socket chat error:', err.message);
      socket.emit('chat-error', { error: 'Failed to send message' });
    }
  });

  // Place bid via socket
  socket.on('send-bid', async ({ auction_id, amount }) => {
    if (!socket.user || socket.user.type === 'admin') return;
    // Throttle: max 1 bid per 2 seconds
    const now = Date.now();
    const lastBid = socket.lastBidTime || 0;
    if (now - lastBid < 2000) {
      socket.emit('bid-error', { error: 'Too many bids. Please wait.' });
      return;
    }
    socket.lastBidTime = now;

    try {
      const bidAmount = parseFloat(amount);
      if (isNaN(bidAmount)) { socket.emit('bid-error', { error: 'Invalid amount' }); return; }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const auctionResult = await client.query("SELECT * FROM auctions WHERE id = $1 AND status = 'LIVE' FOR UPDATE", [auction_id]);
        if (auctionResult.rows.length === 0) {
          await client.query('ROLLBACK');
          socket.emit('bid-error', { error: 'Auction is not live' });
          return;
        }
        const auction = auctionResult.rows[0];
        const elapsed = (auction.elapsed_seconds || 0) + Math.floor((Date.now() - new Date(auction.timer_started_at).getTime()) / 1000);
        if (elapsed >= auction.duration_seconds) {
          await client.query('ROLLBACK');
          socket.emit('bid-error', { error: 'Auction has ended' });
          return;
        }

        const minBid = parseFloat(auction.current_highest_bid || auction.starting_amount);
        const increment = parseFloat(auction.bid_increment);

        if (auction.current_highest_bid === null) {
          if (bidAmount !== parseFloat(auction.starting_amount)) {
            await client.query('ROLLBACK');
            socket.emit('bid-error', { error: `First bid must be ₹${parseFloat(auction.starting_amount).toLocaleString('en-IN')}` });
            return;
          }
        } else {
          if (bidAmount < minBid + increment) {
            await client.query('ROLLBACK');
            socket.emit('bid-error', { error: `Minimum bid is ₹${(minBid + increment).toLocaleString('en-IN')}` });
            return;
          }
        }

        await client.query('UPDATE bids SET is_winning = FALSE WHERE auction_id = $1', [auction_id]);
        const bidResult = await client.query(`
          INSERT INTO bids (auction_id, member_id, amount, is_winning, server_timestamp)
          VALUES ($1, $2, $3, TRUE, $4) RETURNING *
        `, [auction_id, socket.user.id, bidAmount, Date.now()]);
        await client.query(`
          UPDATE auctions SET current_highest_bid = $1, highest_bidder_id = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
        `, [bidAmount, socket.user.id, auction_id]);
        await client.query('COMMIT');

        const memberResult = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [socket.user.id]);
        const member = memberResult.rows[0];
        io.to(`auction_${auction_id}`).emit('auction:new-bid', {
          bid_id: bidResult.rows[0].id,
          amount: bidAmount,
          member_name: member.name,
          member_code: member.member_id,
          bid_time: new Date().toISOString(),
          auction_id,
          highest_bid: bidAmount,
          highest_bidder: member.name,
          highest_bidder_code: member.member_id
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Socket bid error:', err.message);
      socket.emit('bid-error', { error: 'Failed to place bid' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

// ============================================================
// Auto-initialize database tables on startup
// ============================================================
const initDb = async () => {
  try {
    const schemaPath = path.join(__dirname, 'server', 'database', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schemaSql);
      console.log('Database tables verified and initialized successfully.');
    }
  } catch (err) {
    console.warn('Database initialization note:', err.message);
  }
};
initDb();

// Ensure upload directories exist
const uploadDir = process.env.UPLOAD_DIR || './uploads';
[uploadDir, path.join(uploadDir, 'voice')].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Ensure public/assets directory exists (for logo/QR defaults)
const assetsDir = path.join(__dirname, 'public', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// ============================================================
// CORS & Middleware
// ============================================================
const isDevelopment = (process.env.NODE_ENV || 'development') === 'development';
const corsOrigin = isDevelopment ? '*' : (process.env.CORS_ORIGIN || '*');
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(fileUpload({
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760 },
  abortOnLimit: true,
  responseOnLimit: 'File size exceeds the maximum limit.'
}));

// ============================================================
// Static Files
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============================================================
// API Routes
// ============================================================
app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);

app.use('/api/member-auth', memberAuthRoutes);
app.use('/member-auth', memberAuthRoutes);

app.use('/api/members', membersRoutes);
app.use('/members', membersRoutes);

app.use('/api/member-payments', memberPaymentsRoutes);
app.use('/member-payments', memberPaymentsRoutes);

app.use('/api/admin-payments', adminPaymentsRoutes);
app.use('/admin-payments', adminPaymentsRoutes);

app.use('/api/payments', paymentsRoutes);
app.use('/payments', paymentsRoutes);

app.use('/api/withdrawals', withdrawalsRoutes);
app.use('/withdrawals', withdrawalsRoutes);

app.use('/api/transactions', transactionsRoutes);
app.use('/transactions', transactionsRoutes);

app.use('/api/dashboard', dashboardRoutes);
app.use('/dashboard', dashboardRoutes);

app.use('/api/import-export', importExportRoutes);
app.use('/import-export', importExportRoutes);

app.use('/api/admin/members', adminMembersRoutes);
app.use('/admin/members', adminMembersRoutes);

app.use('/api/admin/payments', adminPaymentsNewRoutes);
app.use('/admin/payments', adminPaymentsNewRoutes);

app.use('/api/admin/audit-logs', auditLogsRoutes);
app.use('/admin/audit-logs', auditLogsRoutes);

app.use('/api/payment-verification', paymentVerificationRoutes);
app.use('/payment-verification', paymentVerificationRoutes);

app.use('/api/monthly-payments', monthlyPaymentsRoutes);
app.use('/monthly-payments', monthlyPaymentsRoutes);

// New routes
app.use('/api/auction', auctionRoutes);
app.use('/auction', auctionRoutes);

app.use('/api/chat', chatRoutes);
app.use('/chat', chatRoutes);

app.use('/api/notifications', notificationsRoutes);
app.use('/notifications', notificationsRoutes);

app.use('/api/settings', settingsRoutes);
app.use('/settings', settingsRoutes);

// ============================================================
// Health Check (detailed)
// ============================================================
app.get('/api/health', async (req, res) => {
  let dbStatus = 'unknown';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'healthy';
  } catch (e) {
    dbStatus = 'error';
  }
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbStatus,
    activeAuctionTimers: Object.keys(auctionTimers).length,
    socketConnections: io.engine.clientsCount
  });
});
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

// ============================================================
// Error Handler
// ============================================================
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ============================================================
// Routes: / serves Member Portal, /admin serves Admin Portal
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/member', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/member-ui.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Catch-all: serve member portal for any non-API route
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/') || req.path.startsWith('/assets/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// Start Server
// ============================================================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 PF Chit Fund Club Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔌 Socket.IO: enabled`);
  console.log(`📊 Admin Portal: http://localhost:${PORT}/`);
  console.log(`👤 Member Portal: http://localhost:${PORT}/member-ui.html`);
  console.log('='.repeat(60));
});

module.exports = app;