const pool = require('../config/database');

/**
 * AUTOMATIC SELF-HEALING DEDUPLICATION ENGINE
 * Scans and cleans:
 * 1. Duplicate chat messages (same room, same sender, same text within 5s)
 * 2. Duplicate memberships in chat rooms
 * 3. Duplicate pending group requests
 */
async function runAutoDeduplication() {
  const report = {
    messagesDeduplicated: 0,
    membershipsDeduplicated: 0,
    requestsDeduplicated: 0
  };

  try {
    // 1. Deduplicate Chat Group Messages
    const dupMsgs = await pool.query(`
      SELECT m1.id
      FROM chat_group_messages m1
      JOIN chat_group_messages m2 ON 
        m1.group_id = m2.group_id AND 
        m1.sender_name = m2.sender_name AND 
        m1.message = m2.message AND 
        m1.id > m2.id AND
        abs(strftime('%s', m1.created_at) - strftime('%s', m2.created_at)) <= 5
    `);

    if (dupMsgs.rows && dupMsgs.rows.length > 0) {
      const idsToDelete = dupMsgs.rows.map(r => r.id);
      for (const id of idsToDelete) {
        await pool.query('DELETE FROM chat_group_messages WHERE id = $1', [id]);
      }
      report.messagesDeduplicated += idsToDelete.length;
    }

    // 1b. Deduplicate Auction Chat Messages
    const dupAuctionMsgs = await pool.query(`
      SELECT m1.id
      FROM auction_chat_messages m1
      JOIN auction_chat_messages m2 ON 
        m1.auction_id = m2.auction_id AND 
        m1.sender_name = m2.sender_name AND 
        m1.message = m2.message AND 
        m1.id > m2.id AND
        abs(strftime('%s', m1.created_at) - strftime('%s', m2.created_at)) <= 5
    `);

    if (dupAuctionMsgs.rows && dupAuctionMsgs.rows.length > 0) {
      const idsToDelete = dupAuctionMsgs.rows.map(r => r.id);
      for (const id of idsToDelete) {
        await pool.query('DELETE FROM auction_chat_messages WHERE id = $1', [id]);
      }
      report.messagesDeduplicated += idsToDelete.length;
    }

    // 2. Deduplicate Chat Group Memberships
    const dupMemberships = await pool.query(`
      SELECT m1.id
      FROM chat_group_members m1
      JOIN chat_group_members m2 ON 
        m1.group_id = m2.group_id AND 
        m1.member_id = m2.member_id AND 
        m1.id > m2.id
    `);

    if (dupMemberships.rows && dupMemberships.rows.length > 0) {
      const idsToDelete = dupMemberships.rows.map(r => r.id);
      for (const id of idsToDelete) {
        await pool.query('DELETE FROM chat_group_members WHERE id = $1', [id]);
      }
      report.membershipsDeduplicated = idsToDelete.length;
    }

    // 3. Deduplicate Pending Chat Group Requests
    const dupRequests = await pool.query(`
      SELECT r1.id
      FROM chat_group_requests r1
      JOIN chat_group_requests r2 ON 
        LOWER(r1.group_name) = LOWER(r2.group_name) AND 
        r1.requested_by = r2.requested_by AND 
        r1.status = 'PENDING' AND r2.status = 'PENDING' AND
        r1.id > r2.id
    `);

    if (dupRequests.rows && dupRequests.rows.length > 0) {
      const idsToDelete = dupRequests.rows.map(r => r.id);
      for (const id of idsToDelete) {
        await pool.query('DELETE FROM chat_group_requests WHERE id = $1', [id]);
      }
      report.requestsDeduplicated = idsToDelete.length;
    }

    const totalCleaned = report.messagesDeduplicated + report.membershipsDeduplicated + report.requestsDeduplicated;
    if (totalCleaned > 0) {
      console.log(`[Auto-Deduplicator] Cleaned ${totalCleaned} duplicate records:`, report);
    }
  } catch (err) {
    console.error('[Auto-Deduplicator Warning]', err.message);
  }

  return report;
}

function startBackgroundCleaner() {
  runAutoDeduplication();
  setInterval(runAutoDeduplication, 10 * 60 * 1000);
}

module.exports = {
  runAutoDeduplication,
  startBackgroundCleaner
};
