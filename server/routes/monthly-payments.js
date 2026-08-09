const express = require('express');
const pool = require('../config/database');
const { authenticateToken, adminOnly } = require('../middleware/auth');

const router = express.Router();

// NOTE: This is a new feature and the routes are not yet registered in index.js

/**
 * GET MONTHLY PAYMENT STATUS FOR ALL MEMBERS
 * Admin only
 * GET /api/monthly-payments/status/:year/:month
 */
router.get('/status/:year/:month', authenticateToken, adminOnly, async (req, res) => {
    const { year, month } = req.params;

    try {
        const query = `
        
            SELECT
                m.id,
                m.member_id,
                m.name,
                m.email,
                m.status AS member_status,
                COALESCE(mp.status, 'NOT_GENERATED') AS payment_status,
                mp.amount_paid,
                mp.payment_date
            FROM
                members m
            LEFT JOIN
                monthly_payments mp ON m.id = mp.member_id AND mp.year = $1 AND mp.month = $2
            WHERE
                m.status = 'ACTIVE'
            ORDER BY
                m.name ASC;
        `;
        
        const result = await pool.query(query, [year, month]);
        
        res.json(result.rows);

    } catch (error) {
        console.error(`Error fetching monthly payment status for ${year}-${month}:`, error);
        res.status(500).json({ error: 'Failed to fetch monthly payment status.' });
    }
});

/**
 * GENERATE MONTHLY DUES FOR ALL ACTIVE MEMBERS
 * Admin only
 * POST /api/monthly-payments/generate/:year/:month
 */
router.post('/generate/:year/:month', authenticateToken, adminOnly, async (req, res) => {
    const { year, month } = req.params;
    const defaultAmountDue = 500; // Or get from a config/settings table in the future

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Get all active members
        const membersResult = await client.query("SELECT id FROM members WHERE status = 'ACTIVE'");
        const activeMembers = membersResult.rows;

        let createdCount = 0;
        let existedCount = 0;

        for (const member of activeMembers) {
            // Check if a record already exists
            const existingDue = await client.query(
                `SELECT id FROM monthly_payments 
                 WHERE member_id = $1 AND year = $2 AND month = $3`,
                [member.id, year, month]
            );

            if (existingDue.rows.length > 0) {
                existedCount++;
            } else {
                // Insert a new due record
                const dueDate = new Date(year, month - 1, 15); // Set due date to the 15th of the month
                await client.query(
                    `INSERT INTO monthly_payments (member_id, year, month, amount_due, status, due_date)
                     VALUES ($1, $2, $3, $4, 'DUE', $5)`,
                    [member.id, year, month, defaultAmountDue, dueDate]
                );
                createdCount++;
            }
        }

        await client.query('COMMIT');
        res.json({ 
            message: `Monthly dues generation complete.`,
            created: createdCount,
            already_existed: existedCount,
            total_active_members: activeMembers.length
        });

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('Error generating monthly dues:', error);
        res.status(500).json({ error: 'Failed to generate monthly dues.' });
    } finally {
        if (client) client.release();
    }
});


module.exports = router;
