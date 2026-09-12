// Sync current SQLite database state to initial_data.json
const { syncDatabaseToJson } = require('../server/config/database');

async function main() {
  try {
    await syncDatabaseToJson();
    console.log('Successfully synced database to initial_data.json');
  } catch(e) {
    console.error('Sync failed:', e);
  }
}
main();
