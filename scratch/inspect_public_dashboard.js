const fs = require('fs');
const content = fs.readFileSync('public/public-dashboard.html', 'utf8');
const lines = content.split('\n');
console.log('Total lines in public-dashboard.html:', lines.length);

lines.forEach((line, idx) => {
  const l = line.trim();
  if (l.startsWith('<section') || l.includes('class="section') || l.includes('id="section') || l.includes('class="tab-btn') || l.includes('data-tab=')) {
    console.log(`${idx+1}: ${l.substring(0, 120)}`);
  }
});
