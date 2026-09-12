const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const db = new sqlite3.Database('./server/database/payment_system.sqlite');

async function main() {
  // Set admin password to 'admin123'
  const hash = await bcrypt.hash('admin123', 10);
  console.log('New hash:', hash);
  
  db.run('UPDATE admin_users SET password_hash = ? WHERE username = ?', [hash, 'admin'], function(err) {
    if (err) { console.error('Error:', err); } 
    else { console.log('Admin password reset to admin123 successfully. Rows affected:', this.changes); }
    db.close();
  });
}
main().catch(console.error);
