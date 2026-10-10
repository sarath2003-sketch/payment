const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.join(__dirname, '../public/admin.html');
let content = fs.readFileSync(adminHtmlPath, 'utf8');

// Fix textContent being used with HTML icons
content = content.replace(/\.textContent(\s*=\s*[^;]*<i data-lucide)/g, '.innerHTML$1');
// A few more passes in case of multiple on same line or variations
content = content.replace(/\.textContent(\s*=\s*[^;]*<i data-lucide)/g, '.innerHTML$1');

// Also do it for public-dashboard.html and index.html to be safe
const files = ['public/admin.html', 'public/public-dashboard.html', 'public/index.html', 'public/member-ui.html'];
files.forEach(f => {
  const p = path.join(__dirname, '..', f);
  if (fs.existsSync(p)) {
    let c = fs.readFileSync(p, 'utf8');
    c = c.replace(/\.textContent(\s*=\s*[^;\n]*<i data-lucide)/g, '.innerHTML$1');
    c = c.replace(/confirmTitle'\)\.textContent(\s*=\s*title)/g, "confirmTitle').innerHTML$1");
    c = c.replace(/confirmBody'\)\.textContent(\s*=\s*body)/g, "confirmBody').innerHTML$1");
    fs.writeFileSync(p, c);
  }
});

console.log('Fixed textContent innerHTML bugs');
