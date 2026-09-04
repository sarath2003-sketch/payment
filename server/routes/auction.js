const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/auction — Auction list used by the member history view.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const requestedStatus = String(req.query.status || '').toUpperCase();
    const status = ['SCHEDULED', 'WAITING', 'LIVE', 'PAUSED', 'ENDED', 'CANCELLED'].includes(requestedStatus)
      ? requestedStatus
      : null;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const params = [];
    let whereClause = '';

    if (status) {
      params.push(status);
      whereClause = 'WHERE a.status = $1';
    }

    params.push(limit);
    const result = await pool.query(`
      SELECT a.*, w.name AS winner_name, w.member_id AS winner_code
      FROM auctions a
      LEFT JOIN members w ON a.winner_id = w.id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}
    `, params);

    res.json({ auctions: result.rows });
  } catch (err) {
    console.error('Error fetching auctions:', err);
    res.status(500).json({ error: 'Failed to fetch auctions' });
  }
});

// ============================================================
// HELPER: Broadcast to all Socket.IO clients in auction room
// ============================================================
function broadcastToAuction(io, auctionId, event, data) {
  if (io) {
    io.to(`auction_${auctionId}`).emit(event, data);
  }
}

// ============================================================
// GET /api/auction/current — Public-ish: get active/latest auction
// ============================================================
router.get('/current', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*,
             m.name AS highest_bidder_name,
             m.member_id AS highest_bidder_code,
             w.name AS winner_name,
             w.member_id AS winner_code
      FROM auctions a
      LEFT JOIN members m ON a.highest_bidder_id = m.id
      LEFT JOIN members w ON a.winner_id = w.id
      WHERE a.status IN ('SCHEDULED','WAITING','LIVE','PAUSED')
      ORDER BY a.created_at DESC
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      // Return last ended
      const last = await pool.query(`
        SELECT a.*, w.name AS winner_name, w.member_id AS winner_code
        FROM auctions a
        LEFT JOIN members w ON a.winner_id = w.id
        WHERE a.status = 'ENDED'
        ORDER BY a.ended_at DESC LIMIT 1
      `);
      return res.json({ auction: last.rows[0] || null });
    }
    const auction = result.rows[0];
    // Calculate remaining seconds server-side
    if (auction.status === 'LIVE' && auction.timer_started_at) {
      const elapsed = auction.elapsed_seconds || 0;
      const sinceStart = Math.floor((Date.now() - new Date(auction.timer_started_at).getTime()) / 1000);
      const totalElapsed = elapsed + sinceStart;
      auction.remaining_seconds = Math.max(0, auction.duration_seconds - totalElapsed);
    } else if (auction.status === 'PAUSED') {
      const elapsed = auction.elapsed_seconds || 0;
      auction.remaining_seconds = Math.max(0, auction.duration_seconds - elapsed);
    } else {
      auction.remaining_seconds = auction.duration_seconds;
    }
    res.json({ auction });
  } catch (err) {
    console.error('Error fetching current auction:', err);
    res.status(500).json({ error: 'Failed to fetch auction' });
  }
});

// ============================================================
// GET /api/auction/history — Ended auctions
// ============================================================
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, w.name AS winner_name, w.member_id AS winner_code
      FROM auctions a
      LEFT JOIN members w ON a.winner_id = w.id
      WHERE a.status IN ('ENDED','CANCELLED')
      ORDER BY a.created_at DESC
      LIMIT 50
    `);
    res.json({ auctions: result.rows });
  } catch (err) {
    console.error('Error fetching auction history:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ============================================================
// GET /api/auction/:id/bids — Bid history for an auction
// ============================================================
router.get('/:id/bids', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.id, b.amount, b.bid_time, b.is_winning,
             m.name AS member_name, m.member_id AS member_code
      FROM bids b
      JOIN members m ON b.member_id = m.id
      WHERE b.auction_id = $1
      ORDER BY b.amount DESC, b.bid_time ASC
      LIMIT 100
    `, [req.params.id]);
    res.json({ bids: result.rows });
  } catch (err) {
    console.error('Error fetching bids:', err);
    res.status(500).json({ error: 'Failed to fetch bids' });
  }
});

// ============================================================
// POST /api/auction — Admin: Create auction
// ============================================================
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');
  try {
    const {
      title, description, auction_date, scheduled_start_time,
      duration_seconds, starting_amount, bid_increment
    } = req.body;

    if (!title || !auction_date || !duration_seconds || !starting_amount || !bid_increment) {
      return res.status(400).json({ error: 'title, auction_date, duration_seconds, starting_amount, bid_increment are required' });
    }

    const result = await pool.query(`
      INSERT INTO auctions (title, description, auction_date, scheduled_start_time, duration_seconds, starting_amount, bid_increment, status, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'SCHEDULED', $8)
      RETURNING *
    `, [title, description || null, auction_date, scheduled_start_time || null, parseInt(duration_seconds), parseFloat(starting_amount), parseFloat(bid_increment), req.admin.id]);

    const auction = result.rows[0];

    // Notify all members
    await pool.query(`
      INSERT INTO notifications (member_id, title, body, type, reference_type, reference_id)
      SELECT id, $1, $2, 'auction', 'auction', $3 FROM members WHERE status = 'ACTIVE'
    `, [
      '🔔 Auction Scheduled',
      `"${title}" is scheduled for ${auction_date}${scheduled_start_time ? ' at ' + new Date(scheduled_start_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}`,
      auction.id
    ]);

    if (io) {
      io.emit('auction:scheduled', { auction });
      io.emit('notification:broadcast', {
        title: '🔔 Auction Scheduled',
        body: `"${title}" is scheduled for ${auction_date}`
      });
    }

    res.status(201).json({ message: 'Auction created', auction });
  } catch (err) {
    console.error('Error creating auction:', err);
    res.status(500).json({ error: 'Failed to create auction' });
  }
});

// ============================================================
// PUT /api/auction/:id — Admin: Edit auction (only if SCHEDULED/WAITING)
// ============================================================
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, description, auction_date, scheduled_start_time, duration_seconds, starting_amount, bid_increment } = req.body;
    const auctionResult = await pool.query('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (auctionResult.rows.length === 0) return res.status(404).json({ error: 'Auction not found' });
    const auction = auctionResult.rows[0];
    if (!['SCHEDULED', 'WAITING'].includes(auction.status)) {
      return res.status(400).json({ error: 'Can only edit SCHEDULED or WAITING auctions' });
    }
    const updated = await pool.query(`
      UPDATE auctions SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        auction_date = COALESCE($3, auction_date),
        scheduled_start_time = COALESCE($4, scheduled_start_time),
        duration_seconds = COALESCE($5, duration_seconds),
        starting_amount = COALESCE($6, starting_amount),
        bid_increment = COALESCE($7, bid_increment),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8 RETURNING *
    `, [title, description, auction_date, scheduled_start_time, duration_seconds ? parseInt(duration_seconds) : null, starting_amount ? parseFloat(starting_amount) : null, bid_increment ? parseFloat(bid_increment) : null, req.params.id]);
    res.json({ message: 'Auction updated', auction: updated.rows[0] });
  } catch (err) {
    console.error('Error updating auction:', err);
    res.status(500).json({ error: 'Failed to update auction' });
  }
});

// ============================================================
// POST /api/auction/:id/start — Admin: Start/Go LIVE
// ============================================================
router.post('/:id/start', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Auction not found' }); }
    const auction = result.rows[0];
    if (!['SCHEDULED', 'WAITING', 'PAUSED'].includes(auction.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot start auction in status: ${auction.status}` });
    }
    const now = new Date();
    const updated = await client.query(`
      UPDATE auctions SET status = 'LIVE', timer_started_at = $1, elapsed_seconds = COALESCE(elapsed_seconds, 0), updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *
    `, [now, req.params.id]);
    await client.query('COMMIT');
    const liveAuction = updated.rows[0];
    liveAuction.remaining_seconds = liveAuction.duration_seconds - (liveAuction.elapsed_seconds || 0);

    // Notify members
    await pool.query(`
      INSERT INTO notifications (member_id, title, body, type, reference_type, reference_id)
      SELECT id, $1, $2, 'auction', 'auction', $3 FROM members WHERE status = 'ACTIVE'
    `, ['🔴 Auction is LIVE!', `"${liveAuction.title}" has started! Place your bids now!`, liveAuction.id]);

    if (io) {
      io.emit('auction:state-update', { auction: liveAuction, remaining_seconds: liveAuction.remaining_seconds });
      io.emit('notification:broadcast', { title: '🔴 Auction is LIVE!', body: `"${liveAuction.title}" has started!` });
      // Start server-side timer
      req.app.get('auctionTimerManager').startTimer(liveAuction.id, io);
    }
    res.json({ message: 'Auction started', auction: liveAuction });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error starting auction:', err);
    res.status(500).json({ error: 'Failed to start auction' });
  } finally { client.release(); }
});

// ============================================================
// POST /api/auction/:id/pause — Admin: Pause
// ============================================================
router.post('/:id/pause', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const auction = result.rows[0];
    if (auction.status !== 'LIVE') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Auction is not live' }); }
    const sinceStart = Math.floor((Date.now() - new Date(auction.timer_started_at).getTime()) / 1000);
    const newElapsed = (auction.elapsed_seconds || 0) + sinceStart;
    const updated = await client.query(`
      UPDATE auctions SET status = 'PAUSED', elapsed_seconds = $1, timer_paused_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *
    `, [newElapsed, req.params.id]);
    await client.query('COMMIT');
    if (io) {
      const a = updated.rows[0];
      a.remaining_seconds = Math.max(0, a.duration_seconds - newElapsed);
      io.emit('auction:state-update', { auction: a, remaining_seconds: a.remaining_seconds });
      io.emit('notification:broadcast', { title: '⏸ Auction Paused', body: `"${a.title}" has been paused.` });
      req.app.get('auctionTimerManager').stopTimer(a.id);
    }
    res.json({ message: 'Auction paused', auction: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error pausing auction:', err);
    res.status(500).json({ error: 'Failed to pause' });
  } finally { client.release(); }
});

// ============================================================
// POST /api/auction/:id/resume — Admin: Resume
// ============================================================
router.post('/:id/resume', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const auction = result.rows[0];
    if (auction.status !== 'PAUSED') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Auction is not paused' }); }
    const updated = await client.query(`
      UPDATE auctions SET status = 'LIVE', timer_started_at = CURRENT_TIMESTAMP, timer_paused_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING *
    `, [req.params.id]);
    await client.query('COMMIT');
    const a = updated.rows[0];
    a.remaining_seconds = Math.max(0, a.duration_seconds - (a.elapsed_seconds || 0));
    if (io) {
      io.emit('auction:state-update', { auction: a, remaining_seconds: a.remaining_seconds });
      io.emit('notification:broadcast', { title: '▶️ Auction Resumed', body: `"${a.title}" has resumed!` });
      req.app.get('auctionTimerManager').startTimer(a.id, io);
    }
    res.json({ message: 'Auction resumed', auction: a });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error resuming auction:', err);
    res.status(500).json({ error: 'Failed to resume' });
  } finally { client.release(); }
});

// ============================================================
// POST /api/auction/:id/end — Admin: Force end
// ============================================================
router.post('/:id/end', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');
  try {
    await endAuction(req.params.id, io, pool);
    const result = await pool.query(`
      SELECT a.*, w.name AS winner_name, w.member_id AS winner_code
      FROM auctions a LEFT JOIN members w ON a.winner_id = w.id
      WHERE a.id = $1
    `, [req.params.id]);
    if (io) req.app.get('auctionTimerManager').stopTimer(parseInt(req.params.id));
    res.json({ message: 'Auction ended', auction: result.rows[0] });
  } catch (err) {
    console.error('Error ending auction:', err);
    res.status(500).json({ error: err.message || 'Failed to end auction' });
  }
});

// ============================================================
// POST /api/auction/:id/cancel — Admin: Cancel
// ============================================================
router.post('/:id/cancel', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');
  try {
    const result = await pool.query('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (['ENDED', 'CANCELLED'].includes(result.rows[0].status)) return res.status(400).json({ error: 'Auction already ended/cancelled' });
    await pool.query(`UPDATE auctions SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
    if (io) {
      req.app.get('auctionTimerManager').stopTimer(parseInt(req.params.id));
      io.emit('auction:state-update', { auction: { ...result.rows[0], status: 'CANCELLED' } });
      io.emit('notification:broadcast', { title: '❌ Auction Cancelled', body: `"${result.rows[0].title}" has been cancelled.` });
    }
    res.json({ message: 'Auction cancelled' });
  } catch (err) {
    console.error('Error cancelling auction:', err);
    res.status(500).json({ error: 'Failed to cancel' });
  }
});

// ============================================================
// POST /api/auction/:id/bid — Member: Submit bid
// ============================================================
router.post('/:id/bid', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  if (req.admin?.type === 'admin') return res.status(403).json({ error: 'Admins cannot bid' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const auctionResult = await client.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (auctionResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Auction not found' }); }
    const auction = auctionResult.rows[0];

    if (auction.status !== 'LIVE') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Auction is not live' }); }

    // Check timer not expired
    const elapsed = (auction.elapsed_seconds || 0) + Math.floor((Date.now() - new Date(auction.timer_started_at).getTime()) / 1000);
    if (elapsed >= auction.duration_seconds) {
      await client.query('ROLLBACK');
      // Auto-end
      await endAuction(auction.id, io, pool);
      return res.status(400).json({ error: 'Auction has ended' });
    }

    const bidAmount = parseFloat(req.body.amount);
    const minBid = parseFloat(auction.current_highest_bid || auction.starting_amount);
    const increment = parseFloat(auction.bid_increment);

    if (isNaN(bidAmount) || bidAmount <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid bid amount' }); }
    if (auction.current_highest_bid === null) {
      // First bid must equal starting amount
      if (bidAmount !== parseFloat(auction.starting_amount)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `First bid must be ₹${parseFloat(auction.starting_amount).toLocaleString('en-IN')}` });
      }
    } else {
      const expectedBid = minBid + increment;
      if (bidAmount < expectedBid) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Minimum bid is ₹${expectedBid.toLocaleString('en-IN')}` });
      }
      if ((bidAmount - parseFloat(auction.starting_amount)) % increment !== 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Bid must be in increments of ₹${increment.toLocaleString('en-IN')}` });
      }
    }

    const memberId = req.admin.id;

    // Prevent same member bidding same amount twice
    const dupCheck = await client.query('SELECT id FROM bids WHERE auction_id = $1 AND member_id = $2 AND amount = $3', [auction.id, memberId, bidAmount]);
    if (dupCheck.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'You already placed this exact bid' }); }

    // Reset previous winning bids
    await client.query('UPDATE bids SET is_winning = FALSE WHERE auction_id = $1', [auction.id]);

    // Insert new bid
    const bidResult = await client.query(`
      INSERT INTO bids (auction_id, member_id, amount, is_winning, server_timestamp)
      VALUES ($1, $2, $3, TRUE, $4) RETURNING *
    `, [auction.id, memberId, bidAmount, Date.now()]);

    // Update auction highest bid
    await client.query(`
      UPDATE auctions SET current_highest_bid = $1, highest_bidder_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [bidAmount, memberId, auction.id]);

    await client.query('COMMIT');

    // Fetch member info for broadcast
    const memberResult = await pool.query('SELECT name, member_id FROM members WHERE id = $1', [memberId]);
    const member = memberResult.rows[0];

    const bidData = {
      bid_id: bidResult.rows[0].id,
      amount: bidAmount,
      member_name: member.name,
      member_code: member.member_id,
      bid_time: new Date().toISOString(),
      auction_id: auction.id
    };

    if (io) {
      io.to(`auction_${auction.id}`).emit('auction:new-bid', {
        ...bidData,
        highest_bid: bidAmount,
        highest_bidder: member.name,
        highest_bidder_code: member.member_id
      });
    }

    res.json({ message: 'Bid placed successfully', bid: bidData });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error placing bid:', err);
    res.status(500).json({ error: 'Failed to place bid' });
  } finally { client.release(); }
});

// Alias: GET /api/live-activities/:id & GET /api/auction/:id
router.get('/details/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*,
             m.name AS highest_bidder_name, m.member_id AS highest_bidder_code, m.profile_photo AS highest_bidder_photo,
             w.name AS winner_name, w.member_id AS winner_code, w.profile_photo AS winner_photo
      FROM auctions a
      LEFT JOIN members m ON a.highest_bidder_id = m.id
      LEFT JOIN members w ON a.winner_id = w.id
      WHERE a.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Live activity not found' });
    }

    const a = result.rows[0];
    if (a.status === 'LIVE' && a.timer_started_at) {
      const elapsed = (a.elapsed_seconds || 0) + Math.floor((Date.now() - new Date(a.timer_started_at).getTime()) / 1000);
      a.remainingSeconds = Math.max(0, a.duration_seconds - elapsed);
    } else {
      a.remainingSeconds = a.duration_seconds || 0;
    }

    res.json({ success: true, data: a, auction: a });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch live activity' });
  }
});

// Alias: POST /api/live-activities/:id/amount & POST /api/auction/:id/amount (With ₹100 rule & 409 Conflict concurrency check)
router.post('/:id/amount', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  if (req.admin?.type === 'admin') return res.status(403).json({ success: false, message: 'Admins cannot update amount' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const auctionId = req.params.id;
    const auctionResult = await client.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);
    if (auctionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Live activity not found' });
    }
    const auction = auctionResult.rows[0];
    if (auction.status !== 'LIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Live activity is not active' });
    }

    const elapsed = (auction.elapsed_seconds || 0) + Math.floor((Date.now() - new Date(auction.timer_started_at).getTime()) / 1000);
    if (elapsed >= auction.duration_seconds) {
      await client.query('ROLLBACK');
      await endAuction(auction.id, io, pool);
      return res.status(400).json({ success: false, message: 'Live activity has ended' });
    }

    const newAmount = parseFloat(req.body.amount || req.body.newAmount);
    const currentAmount = parseFloat(auction.current_highest_bid || auction.starting_amount);
    const increment = parseFloat(auction.bid_increment || 100);

    if (isNaN(newAmount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    if (auction.current_highest_bid !== null && (newAmount - currentAmount !== increment)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Amount must be increased by exactly ₹${increment}` });
    }

    const memberId = req.admin.id;

    // Optimistic concurrency update
    const updateResult = await client.query(`
      UPDATE auctions 
      SET current_highest_bid = $1, highest_bidder_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND status = 'LIVE' AND (current_highest_bid = $4 OR current_highest_bid IS NULL)
      RETURNING *
    `, [newAmount, memberId, auctionId, auction.current_highest_bid]);

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Amount has already been updated. Refresh and try again.' });
    }

    await client.query('INSERT INTO bids (auction_id, member_id, amount, is_winning, server_timestamp) VALUES ($1, $2, $3, TRUE, $4)', [auctionId, memberId, newAmount, Date.now()]);
    await client.query('COMMIT');

    const mRes = await pool.query('SELECT name, member_id, profile_photo FROM members WHERE id = $1', [memberId]);
    const member = mRes.rows[0];

    const broadcastData = {
      auction_id: parseInt(auctionId),
      amount: newAmount,
      highest_bidder_id: memberId,
      highest_bidder_name: member?.name,
      highest_bidder_code: member?.member_id,
      profile_photo: member?.profile_photo
    };

    if (io) {
      io.emit('auction:bid-update', broadcastData);
      io.to(`auction_${auctionId}`).emit('bid-placed', broadcastData);
    }

    res.json({ success: true, message: 'Amount updated successfully', data: broadcastData });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating amount:', err);
    res.status(500).json({ success: false, message: 'Failed to update amount' });
  } finally {
    client.release();
  }
});

// ============================================================
// SHARED: End Auction Logic (called by timer or admin)
// ============================================================
async function endAuction(auctionId, io, db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);
    if (result.rows.length === 0) { await client.query('ROLLBACK'); throw new Error('Auction not found'); }
    const auction = result.rows[0];
    if (['ENDED', 'CANCELLED'].includes(auction.status)) { await client.query('ROLLBACK'); return; }

    // Determine winner
    const winningBid = await client.query(`
      SELECT b.*, m.name AS member_name, m.member_id AS member_code
      FROM bids b JOIN members m ON b.member_id = m.id
      WHERE b.auction_id = $1
      ORDER BY b.amount DESC, b.bid_time ASC
      LIMIT 1
    `, [auctionId]);

    let winnerId = null, finalAmount = null, winnerName = null, winnerCode = null;
    if (winningBid.rows.length > 0) {
      winnerId = winningBid.rows[0].member_id;
      finalAmount = winningBid.rows[0].amount;
      winnerName = winningBid.rows[0].member_name;
      winnerCode = winningBid.rows[0].member_code;
    }

    await client.query(`
      UPDATE auctions SET
        status = 'ENDED',
        winner_id = $1,
        final_amount = $2,
        ended_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [winnerId, finalAmount, auctionId]);

    // Automatically create a ledger transaction for winner
    if (winnerId && finalAmount) {
      const todayDate = new Date().toISOString().split('T')[0];
      const timeStr = new Date().toTimeString().split(' ')[0];
      const monthStr = todayDate.substring(0, 7);
      const winAmt = parseFloat(finalAmount);

      await client.query(`
        INSERT INTO transactions (
          member_id, transaction_date, transaction_time, month,
          transaction_type, amount, description, reference_type,
          reference_id, status
        ) VALUES ($1, $2, $3, $4, 'DEBIT', $5, $6, 'AUCTION_WIN', $7, 'COMPLETED')
      `, [
        winnerId,
        todayDate,
        timeStr,
        monthStr,
        winAmt,
        `Auction Winner Payout — ${auction.title} (Winning Bid: ₹${winAmt.toLocaleString('en-IN')})`,
        auctionId
      ]);

      // Audit Log
      await client.query(`
        INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details)
        VALUES ('system', 0, 'System', 'AUCTION_WINNER_SELECTED', 'auction', $1, $2)
      `, [
        auctionId,
        `Winner ${winnerName} (${winnerCode}) won auction #${auctionId} with bid ₹${winAmt}`
      ]);
    }

    await client.query('COMMIT');

    // Notify members
    if (winnerName) {
      await db.query(`
        INSERT INTO notifications (member_id, title, body, type, reference_type, reference_id)
        SELECT id, $1, $2, 'auction', 'auction', $3 FROM members WHERE status = 'ACTIVE'
      `, [
        '🏆 Auction Ended!',
        `Winner: ${winnerName} (${winnerCode}) with ₹${parseFloat(finalAmount).toLocaleString('en-IN')}`,
        auctionId
      ]);
    } else {
      await db.query(`
        INSERT INTO notifications (member_id, title, body, type, reference_type, reference_id)
        SELECT id, $1, $2, 'auction', 'auction', $3 FROM members WHERE status = 'ACTIVE'
      `, ['Auction Ended', 'The auction has ended with no bids.', auctionId]);
    }

    if (io) {
      io.emit('auction:ended', {
        auction_id: auctionId,
        winner_name: winnerName,
        winner_code: winnerCode,
        final_amount: finalAmount,
        auction_title: auction.title
      });
      io.emit('notification:broadcast', {
        title: '🏆 Auction Ended!',
        body: winnerName
          ? `Winner: ${winnerName} with ₹${parseFloat(finalAmount).toLocaleString('en-IN')}`
          : 'Auction ended with no bids.'
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
module.exports.endAuction = endAuction;
