const fs = require('fs');
const path = require('path');

const files = [
  'public/index.html',
  'public/admin.html',
  'public/public-dashboard.html',
  'public/login.html',
  'public/member-ui.html'
];

const newVars = `
    :root {
      /* FinTrack AI Theme - Premium Dark */
      --bg: #0B0F19;           /* Deep dark background */
      --surface: #151C2C;      /* Slightly lighter for cards */
      --surface2: #1E293B;     /* Hover states / secondary cards */
      
      --primary: #6366F1;      /* Indigo / AI Purple-Blue */
      --primary-hover: #818CF8;
      --primary-light: rgba(99, 102, 241, 0.15);
      
      --gold: #3B82F6;         /* Repurposed gold to bright blue */
      --gold-light: #60A5FA;
      --gold-dark: #2563EB;
      
      --text: #F8FAFC;         /* Crisp white text */
      --text2: #CBD5E1;        /* Light slate for secondary text */
      --text3: #94A3B8;        /* Slate for muted text */
      --white: #FFFFFF;
      
      --border: #1E293B;       /* Dark borders */
      --border2: #334155;      
      
      --green: #10B981;        /* Finance Green */
      --green-light: #34D399;
      --red: #EF4444;          /* Finance Red */
      --blue: #3B82F6;
      --orange: #F59E0B;
      
      --radius: 16px;
      --radius-sm: 8px;
      --shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
      --shadow-gold: 0 4px 20px rgba(99, 102, 241, 0.3); /* Glowing AI shadow */
      
      --font-ta: 'Inter', sans-serif;
      --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
`;

files.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace :root variables with new FinTrack theme
  content = content.replace(/:root\s*{[\s\S]*?--transition:[^;]+;[^\}]*}/, newVars);

  // Fix hardcoded inline styles that were broken by previous light theme attempt
  // E.g., make sure any inline 'color: var(--text)' is preserved, 
  // but if there are weird hardcoded colors that clash with dark theme, fix them.
  content = content.replace(/background:\s*#f8fafc/g, 'background: var(--bg)');
  content = content.replace(/background-color:\s*#f8fafc/g, 'background-color: var(--bg)');
  content = content.replace(/color:\s*#0f172a/g, 'color: var(--text)');
  content = content.replace(/color:\s*#334155/g, 'color: var(--text2)');
  content = content.replace(/color:\s*#64748b/g, 'color: var(--text3)');
  content = content.replace(/background:\s*#ffffff/g, 'background: var(--surface)');
  content = content.replace(/background-color:\s*#ffffff/g, 'background-color: var(--surface)');
  content = content.replace(/border:\s*1px solid #e2e8f0/g, 'border: 1px solid var(--border)');
  
  // Specifically target card values and stats to look like a modern finance app
  content = content.replace(/background:\s*rgba\(245,200,66,0\.05\)/g, 'background: var(--primary-light)');
  content = content.replace(/border:\s*1px solid var\(--border\)/g, 'border: 1px solid var(--border)');
  
  // Clean up any remaining white backgrounds on cards
  content = content.replace(/background:\s*white/gi, 'background: var(--surface)');
  content = content.replace(/background-color:\s*white/gi, 'background-color: var(--surface)');

  // Fix button styles (AI Finance gradient)
  content = content.replace(/background:\s*var\(--gold\)/g, 'background: linear-gradient(135deg, var(--primary), #3B82F6)');
  content = content.replace(/background-color:\s*var\(--gold\)/g, 'background: linear-gradient(135deg, var(--primary), #3B82F6)');
  content = content.replace(/background:\s*var\(--primary\)/g, 'background: linear-gradient(135deg, var(--primary), #3B82F6)');
  content = content.replace(/background-color:\s*var\(--primary\)/g, 'background: linear-gradient(135deg, var(--primary), #3B82F6)');

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated ${file} to FinTrack Theme`);
});
