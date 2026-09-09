/**
 * PF Chit Fund Club — Past Excel Data Importer (June & July 2026)
 * Pre-populates 20 members, June & July ₹500 contributions,
 * payment proofs, transactions, and 6 nominee loan distributions.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.resolve(__dirname, '../database/payment_system.sqlite');
console.log('Connecting to database:', DB_PATH);

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Failed to open database:', err);
    process.exit(1);
  }
});

// The 20 members from the Excel files
const MEMBER_NAMES = [
  'Ajith',
  'Gokul',
  'jagan',
  'kannan',
  'karthik',
  'kirshna',
  'logu',
  'mathivanam',
  'murugesan',
  'nagaraj',
  'nallaiya',
  'palraj',
  'ponnar',
  'prasanth',
  'praveen',
  'rajash',
  'sathish',
  'siva',
  'vishal',
  'Santhosh'
];

// 6 Seed Fund / Chit Loan distributions
const LOAN_DISTRIBUTIONS = [
  // June 2026
  {
    nominee: 'Santhosh',
    memberName: 'Santhosh',
    month: '2026-06',
    distribution_date: '2026-06-10',
    principal: 4750,
    interest: 850,
    total_payable: 5600,
    status: 'COMPLETED',
    notes: 'June 2026 Chit Distribution — Santhosh (Principal: ₹4,750, Interest: ₹850, Total: ₹5,600)'
  },
  {
    nominee: 'Sathis',
    memberName: 'sathish',
    month: '2026-06',
    distribution_date: '2026-06-10',
    principal: 4750,
    interest: 900,
    total_payable: 5650,
    status: 'COMPLETED',
    notes: 'June 2026 Chit Distribution — Sathish (Principal: ₹4,750, Interest: ₹900, Total: ₹5,650)'
  },
  // July 2026
  {
    nominee: 'Mathivanam',
    memberName: 'mathivanam',
    month: '2026-07',
    distribution_date: '2026-07-10',
    principal: 5000,
    interest: 850,
    total_payable: 5850,
    status: 'PENDING',
    notes: 'July 2026 Chit Distribution — Mathivanam (Principal: ₹5,000, Interest: ₹850, Total: ₹5,850)'
  },
  {
    nominee: 'Santhosh',
    memberName: 'Santhosh',
    month: '2026-07',
    distribution_date: '2026-07-10',
    principal: 5000,
    interest: 1100,
    total_payable: 6100,
    status: 'PENDING',
    notes: 'July 2026 Chit Distribution — Santhosh (Principal: ₹5,000, Interest: ₹1,100, Total: ₹6,100)'
  },
  {
    nominee: 'Prasanth',
    memberName: 'prasanth',
    month: '2026-07',
    distribution_date: '2026-07-10',
    principal: 5000,
    interest: 1100,
    total_payable: 6100,
    status: 'PENDING',
    notes: 'July 2026 Chit Distribution — Prasanth (Principal: ₹5,000, Interest: ₹1,100, Total: ₹6,100)'
  },
  {
    nominee: 'Sathis',
    memberName: 'sathish',
    month: '2026-07',
    distribution_date: '2026-07-10',
    principal: 5000,
    interest: 700,
    total_payable: 5700,
    status: 'PENDING',
    notes: 'July 2026 Chit Distribution — Sathish (Principal: ₹5,000, Interest: ₹700, Total: ₹5,700)'
  }
];

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function main() {
  console.log('=== Starting Past Excel Data Import ===');

  const defaultPasswordHash = await bcrypt.hash('123456', 10);
  const memberMap = {}; // name (lower) -> { id, member_id, name, phone }

  // 1. Fetch existing members
  const existingMembers = await allAsync('SELECT id, member_id, name, phone FROM members');
  for (const m of existingMembers) {
    memberMap[m.name.toLowerCase()] = m;
  }
  console.log(`Found ${existingMembers.length} existing member(s).`);

  // 2. Ensure each of the 20 members exists
  let nextMemberNum = 101;
  for (const m of existingMembers) {
    const num = parseInt(m.member_id, 10);
    if (!isNaN(num) && num >= nextMemberNum) {
      nextMemberNum = num + 1;
    }
  }

  for (let i = 0; i < MEMBER_NAMES.length; i++) {
    const rawName = MEMBER_NAMES[i];
    const key = rawName.toLowerCase();
    const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);

    if (memberMap[key]) {
      console.log(`Member already exists: ${displayName} (ID: ${memberMap[key].id}, Code: ${memberMap[key].member_id})`);
      await runAsync(
        `UPDATE members SET balance = 1000.00, payment_status = 'PAID', activation_status = 'ACTIVE' WHERE id = ?`,
        [memberMap[key].id]
      );
    } else {
      const code = String(nextMemberNum++);
      const placeholderPhone = `0000000${code}`.slice(-10);
      const email = `${rawName.toLowerCase()}_${code}@pfchitfund.com`;

      const insertRes = await runAsync(
        `INSERT INTO members (
          member_id, name, email, phone, password_hash, balance, status, activation_status, payment_status, group_category
        ) VALUES (?, ?, ?, ?, ?, 1000.00, 'ACTIVE', 'ACTIVE', 'PAID', 'General')`,
        [code, displayName, email, placeholderPhone, defaultPasswordHash]
      );

      const newId = insertRes.lastID;
      memberMap[key] = { id: newId, member_id: code, name: displayName, phone: placeholderPhone };
      console.log(`Created member: ${displayName} (ID: ${newId}, Code: ${code}, Phone: ${placeholderPhone})`);
    }
  }

  // 3. Insert June 2026 & July 2026 Monthly Payments + Payment Proofs + Transactions
  console.log('\n--- Backfilling June & July 2026 Contributions ---');
  const months = [
    { year: 2026, month: 6, date: '2026-06-10', monthName: 'June 2026', ref: 'UPI-JUN-2026-EXCEL' },
    { year: 2026, month: 7, date: '2026-07-10', monthName: 'July 2026', ref: 'UPI-JUL-2026-EXCEL' }
  ];

  let paymentsCount = 0;
  let proofsCount = 0;

  for (const rawName of MEMBER_NAMES) {
    const mem = memberMap[rawName.toLowerCase()];
    if (!mem) continue;

    for (const mInfo of months) {
      const existingPayment = await getAsync(
        'SELECT id FROM monthly_payments WHERE member_id = ? AND year = ? AND month = ?',
        [mem.id, mInfo.year, mInfo.month]
      );

      if (!existingPayment) {
        const proofRes = await runAsync(
          `INSERT INTO payment_proofs (
            member_id, amount, transaction_reference, payment_month, payment_date, proof_file_path, status, verified_by, verified_at
          ) VALUES (?, 500.00, ?, ?, ?, '/assets/verified_receipt.png', 'APPROVED', 1, CURRENT_TIMESTAMP)`,
          [mem.id, `${mInfo.ref}-${mem.member_id}`, `${mInfo.year}-${String(mInfo.month).padStart(2, '0')}`, mInfo.date]
        );
        const proofId = proofRes.lastID;
        proofsCount++;

        await runAsync(
          `INSERT INTO monthly_payments (
            member_id, year, month, amount_due, amount_paid, status, due_date, payment_date, payment_proof_id, notes
          ) VALUES (?, ?, ?, 500.00, 500.00, 'PAID', ?, ?, ?, ?)`,
          [mem.id, mInfo.year, mInfo.month, mInfo.date, mInfo.date, proofId, `Imported from ${mInfo.monthName} Chit Sequence (UPI Paid)`]
        );
        paymentsCount++;

        await runAsync(
          `INSERT INTO transactions (
            member_id, transaction_date, transaction_time, month, transaction_type, amount, description, reference_type, reference_id, status, balance_after
          ) VALUES (?, ?, '10:00:00', ?, 'PAYMENT', 500.00, ?, 'EXCEL_IMPORT', ?, 'COMPLETED', ?)`,
          [
            mem.id,
            mInfo.date,
            mInfo.monthName,
            `Chit Monthly Payment for ${mInfo.monthName} (UPI Verified)`,
            proofId,
            mInfo.month === 6 ? 500.00 : 1000.00
          ]
        );
      }
    }
  }

  console.log(`Inserted ${paymentsCount} monthly payments and ${proofsCount} payment proofs.`);

  // 4. Backfill Seed Fund / Chit Loan Distributions
  console.log('\n--- Backfilling 6 Seed Fund / Chit Loan Distributions ---');
  let distCount = 0;

  for (const item of LOAN_DISTRIBUTIONS) {
    const mem = memberMap[item.memberName.toLowerCase()];
    const memberDbId = mem ? mem.id : 1;

    const existingDist = await getAsync(
      `SELECT id FROM seed_fund_distributions WHERE nominee_name = ? AND distribution_date = ? AND principal_amount = ?`,
      [item.nominee, item.distribution_date, item.principal]
    );

    if (!existingDist) {
      const interestPct = ((item.interest / item.principal) * 100).toFixed(2);
      await runAsync(
        `INSERT INTO seed_fund_distributions (
          group_id, member_id, principal_amount, interest_percentage, interest_amount,
          total_payable, total_repaid, remaining_amount, monthly_amount, number_of_months,
          distribution_date, due_date, nominee_name, payment_status, notes
        ) VALUES (
          1, ?, ?, ?, ?,
          ?, 0.00, ?, ?, 12,
          ?, '2027-06-10', ?, ?, ?
        )`,
        [
          memberDbId,
          item.principal,
          interestPct,
          item.interest,
          item.total_payable,
          item.total_payable,
          Math.round(item.total_payable / 12),
          item.distribution_date,
          item.nominee,
          item.status,
          item.notes
        ]
      );
      distCount++;
      console.log(`Added loan distribution: ${item.nominee} (₹${item.principal} + ₹${item.interest} = ₹${item.total_payable})`);
    } else {
      console.log(`Loan distribution already exists: ${item.nominee} (${item.distribution_date})`);
    }
  }

  console.log(`Inserted ${distCount} seed fund loan distribution records.`);
  console.log('\n=== All Past Data Imported Successfully! ===');
  db.close();
}

main().catch(err => {
  console.error('Import error:', err);
  process.exit(1);
});
