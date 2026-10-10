const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.join(__dirname, '../public/admin.html');
let content = fs.readFileSync(adminHtmlPath, 'utf8');

// Fix adminUploadProof function
const oldUploadFunction = `function adminUploadProof(paymentId) {
      _adminProofTargetId = paymentId;
      const inp = document.getElementById('adminProofFileInput');
      if (!inp) return;`;

const newUploadFunction = `function adminUploadProof(paymentId) {
      _adminProofTargetId = paymentId;
      let inp = document.getElementById('adminProofFileInput');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file';
        inp.id = 'adminProofFileInput';
        inp.accept = 'image/jpeg,image/png,image/webp,application/pdf';
        inp.style.display = 'none';
        document.body.appendChild(inp);
      }`;

content = content.replace(oldUploadFunction, newUploadFunction);

// Ensure the Repayments table has an Actions column so they can delete/edit/upload proof if needed
// Actually, the user just wanted to ADD a repayment. The Record Repayment modal is already there.
// But they said "last month yaar yaar loan-ukku approval koduthirukkeno, avanga amount pay pannitanga. Adhaiyum naan add pannanum"
// Let's add a clear empty state message instructing them to click "+ Record Repayment".
content = content.replace(
  'No repayments recorded yet.', 
  'No repayments recorded yet. Click "+ Record Repayment" to add the amounts paid by members for their loans.'
);

// Also remove any rogue IIFE that might have failed
content = content.replace(/\(function\(\) \{\s*const inp = document\.createElement\('input'\);\s*inp\.type = 'file';\s*inp\.id = 'adminProofFileInput';\s*inp\.accept[^;]+;\s*inp\.style\.display = 'none';\s*document\.body\.appendChild\(inp\);\s*\}\)\(\);/, '');

fs.writeFileSync(adminHtmlPath, content);
console.log('Fixed adminUploadProof and IIFE');
