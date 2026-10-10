const fs = require('fs');
const path = require('path');

const files = [
  'public/index.html',
  'public/admin.html',
  'public/public-dashboard.html',
  'public/login.html',
  'public/member-ui.html'
];

files.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Fix placeholder attributes that contain HTML
  content = content.replace(/placeholder="([^"]*?)<i[^>]*>.*?<\/i>([^"]*?)"/g, 'placeholder="$1$2"');
  // Run it a few times in case there are multiple icons in one placeholder
  content = content.replace(/placeholder="([^"]*?)<i[^>]*>.*?<\/i>([^"]*?)"/g, 'placeholder="$1$2"');
  content = content.replace(/placeholder="([^"]*?)<i[^>]*>.*?<\/i>([^"]*?)"/g, 'placeholder="$1$2"');
  content = content.replace(/placeholder="([^"]*?)<i[^>]*>.*?<\/i>([^"]*?)"/g, 'placeholder="$1$2"');

  // Fix value attributes that contain HTML
  content = content.replace(/value="([^"]*?)<i[^>]*>.*?<\/i>([^"]*?)"/g, 'value="$1$2"');

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Repaired ${file}`);
});
