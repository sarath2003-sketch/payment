const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const db = new sqlite3.Database('./server/database/payment_system.sqlite');

db.all('SELECT id, username, password_hash, email FROM admin_users', [], async (err, rows) => {
  if (err) { console.error(err); return; }
  console.log('ADMIN USERS:', JSON.stringify(rows));
  
  // Try common passwords
  const passwords = ['admin123', 'Admin123', 'admin@123', 'password', 'admin1234', '123456', 'admin', 'admin123456'];
  for (const user of rows) {
    for (const pw of passwords) {
      const match = await bcrypt.compare(pw, user.password_hash);
      if (match) {
        console.log(`FOUND: username='${user.username}' password='${pw}'`);
      }
    }
  }
  db.close();
});
