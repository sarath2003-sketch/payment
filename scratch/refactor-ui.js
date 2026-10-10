const fs = require('fs');
const path = require('path');

const files = [
  'public/index.html',
  'public/admin.html',
  'public/public-dashboard.html',
  'public/login.html',
  'public/member-ui.html'
];

const emojiToLucide = {
  '💰': 'circle-dollar-sign',
  '🏆': 'award',
  '🛡️': 'shield',
  '🚨': 'alert-circle',
  '⚠️': 'alert-triangle',
  '✅': 'check-circle',
  '❌': 'x-circle',
  '👁️': 'eye',
  '⏳': 'hourglass',
  '👥': 'users',
  '💡': 'lightbulb',
  '📥': 'arrow-down-to-line',
  '📤': 'arrow-up-to-line',
  '🖨️': 'printer',
  '📝': 'file-text',
  '📉': 'trending-down',
  '📊': 'bar-chart',
  '📅': 'calendar',
  '💳': 'credit-card',
  '₹': 'indian-rupee',
  '👑': 'crown',
  '📱': 'smartphone',
  '🔔': 'bell',
  '⚙️': 'settings',
  '🔒': 'lock',
  '🔑': 'key',
  '🚀': 'rocket',
  '🎉': 'party-popper',
  '🔥': 'flame',
  '📈': 'trending-up',
  '🔍': 'search',
  '➕': 'plus',
  '➖': 'minus',
  '⬅️': 'arrow-left',
  '➡️': 'arrow-right',
  '⬇️': 'arrow-down',
  '⬆️': 'arrow-up',
  '👋': 'hand',
  '🛑': 'octagon-alert',
  '🏦': 'landmark',
  '💵': 'banknote',
  '💸': 'coins',
  '🪙': 'circle-dollar-sign',
  '📜': 'scroll',
  '📋': 'clipboard',
  '📎': 'paperclip',
  '📑': 'bookmark',
  '📁': 'folder',
  '📂': 'folder-open',
  '🗑️': 'trash-2',
  '✏️': 'pencil',
  '⏱️': 'timer',
  '🕒': 'clock',
  '📌': 'pin',
  '🏠': 'home'
};

const newVars = `
    :root {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-light: #eff6ff;
      --gold: #2563eb; /* Overriding old gold with blue */
      --gold-light: #eff6ff;
      --gold-dark: #1e40af;
      
      --bg: #f8fafc;
      --dark: #f8fafc;
      --dark2: #f1f5f9;
      --dark3: #e2e8f0;
      --dark4: #cbd5e1;
      
      --surface: #ffffff;
      --surface2: #f8fafc;
      
      --border: #e2e8f0;
      --border2: #cbd5e1;
      
      --text: #0f172a;
      --text2: #334155;
      --text3: #64748b;
      
      --white: #ffffff;
      --green: #10b981;
      --red: #ef4444;
      --blue: #3b82f6;
      --orange: #f59e0b;
      
      --radius: 8px;
      --radius-sm: 4px;
      --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
      --shadow-gold: 0 4px 12px rgba(37, 99, 235, 0.1);
      
      --font-ta: 'Inter', sans-serif;
      --transition: all 0.2s ease;
    }
`;

files.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace old CSS vars block
  // We'll target the :root block inside <style>
  content = content.replace(/:root\s*{[\s\S]*?--transition:[^;]+;[^\}]*}/, newVars);

  // Replace background gradients and black backgrounds
  content = content.replace(/background:\s*var\(--dark\)/g, 'background: var(--bg)');
  content = content.replace(/background:\s*#000/g, 'background: var(--bg)');
  content = content.replace(/background:\s*#111/g, 'background: var(--surface)');
  content = content.replace(/background:\s*#222/g, 'background: var(--surface2)');
  content = content.replace(/background:\s*#1a1005/g, 'background: var(--bg)');
  content = content.replace(/background:\s*#08070d/g, 'background: var(--bg)');
  content = content.replace(/radial-gradient\([^\)]+\)/g, 'var(--bg)');
  content = content.replace(/background-color:\s*#111/g, 'background-color: var(--surface)');
  content = content.replace(/color:\s*#fff/g, 'color: var(--text)');
  content = content.replace(/color:\s*white/g, 'color: var(--text)');
  content = content.replace(/color:\s*#f0e6c0/g, 'color: var(--text)');
  
  // Buttons and inputs: remove excessive borders, adjust border radius
  content = content.replace(/border-radius:\s*16px/g, 'border-radius: var(--radius)');
  content = content.replace(/border-radius:\s*24px/g, 'border-radius: var(--radius)');
  content = content.replace(/box-shadow:\s*0 8px 32px rgba\(0,0,0,0.5\)/g, 'box-shadow: var(--shadow)');
  content = content.replace(/box-shadow:\s*0\s*0\s*24px[^\;]+/g, 'box-shadow: var(--shadow)');
  content = content.replace(/backdrop-filter:\s*blur\([^\)]+\)/g, '/* removed backdrop */');
  
  // Holographic classes removal / silencing
  content = content.replace(/\.theme-\w+\s*{[^}]+}/g, '');
  content = content.replace(/\.aurora\s*{[\s\S]*?}/g, '.aurora { display: none; }');
  content = content.replace(/\.blob\s*{[\s\S]*?}/g, '.blob { display: none; }');
  content = content.replace(/\.holo-card\s*{[\s\S]*?}/g, '.holo-card { background: var(--surface); box-shadow: var(--shadow); border-radius: var(--radius); border: 1px solid var(--border); width: min(400px, 94vw); position: relative; margin: 40px auto; }');
  content = content.replace(/\.holo-layer\s*{[\s\S]*?}/g, '.holo-layer { display: none; }');

  // Emojis to Lucide icons
  for (const [emoji, icon] of Object.entries(emojiToLucide)) {
    const regex = new RegExp(emoji, 'g');
    content = content.replace(regex, `<i data-lucide="${icon}" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>`);
  }
  
  // Include Lucide script if not exists
  if (!content.includes('lucide.min.js') && !content.includes('unpkg.com/lucide')) {
    content = content.replace('</body>', '  <script src="https://unpkg.com/lucide@latest"></script>\n  <script>lucide.createIcons();</script>\n</body>');
  }

  // Ensure Inter font is prioritized
  content = content.replace(/font-family:\s*'Noto Sans Tamil'/g, "font-family: 'Inter'");
  
  // Make inputs and buttons look professional
  content = content.replace(/border:\s*1px solid var\(--border\)/g, 'border: 1px solid var(--border)');
  content = content.replace(/border:\s*1px solid var\(--gold\)/g, 'border: 1px solid var(--primary)');
  content = content.replace(/background:\s*var\(--surface\)/g, 'background: var(--surface)');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated ${file}`);
});
