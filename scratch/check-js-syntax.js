const fs = require('fs');
const html = fs.readFileSync('public/admin.html', 'utf8');

// extract the <script> tags
const scripts = [];
let regex = /<script>([\s\S]*?)<\/script>/g;
let match;
while ((match = regex.exec(html)) !== null) {
  scripts.push(match[1]);
}

scripts.forEach((script, i) => {
  fs.writeFileSync(`scratch/test-admin-script-${i}.js`, script);
  try {
    require('vm').Script(script);
    console.log(`Script ${i} parses successfully.`);
  } catch(e) {
    console.error(`Script ${i} syntax error:`, e);
  }
});
