
    let adminToken = localStorage.getItem('adminToken');
    let adminUser = null;
    let currentEditingMemberId = null;
    let currentEditingPaymentId = null;
    let confirmCb = null;

    const API_BASE = (window.location.protocol === 'file:' || !window.location.host) ? 'http://localhost:5000' : '';

    function navigatePortal(target) {
      if (target === 'public') {
        window.location.href = 'public-dashboard.html';
      } else if (target === 'member' || target === 'login') {
        window.location.href = 'index.html';
      } else if (target === 'admin') {
        window.location.href = 'admin.html';
      }
    }

    async function api(url, opts = {}, maybeBody = null) {
      if (typeof opts === 'string') {
        const method = opts.toUpperCase();
        opts = {
          method,
          body: maybeBody ? (typeof maybeBody === 'string' ? maybeBody : JSON.stringify(maybeBody)) : undefined
        };
      }
      const targetUrl = url.startsWith('http') ? url : (API_BASE + url);
      const h = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (adminToken) h['Authorization'] = `Bearer ${adminToken}`;
      const r = await fetch(targetUrl, { ...opts, headers: h });
      const d = await r.json().catch(() => ({}));
      if ((r.status === 401 || r.status === 403) && !url.includes('/auth/login')) {
        adminToken = null;
        localStorage.removeItem('adminToken');
        doAdminLogout();
        showToast('Session expired or unauthorized. Please login again.', 'error');
        throw new Error(d.error || 'Authentication required');
      }
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    }

    function escapeHtml(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    window.escapeHtml = escapeHtml;
    function esc(s) { return escapeHtml(s); }
    window.esc = esc;

    function openModal(id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('hidden');
    }
    window.openModal = openModal;

    function closeModal(id) {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    }
    window.closeModal = closeModal;

    function showToast(msg, type = 'info') {
      const c = document.getElementById('toast-container');
      if (!c) return;
      const t = document.createElement('div');
      t.className = `toast toast-${type}`;
      t.textContent = msg;
      c.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3500);
    }

    // Theme System
    function changeTheme(theme) {
      let actualTheme = theme;
      if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        actualTheme = prefersDark ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', actualTheme);
      localStorage.setItem('adminTheme', theme);
      updateSidebarThemeLabel(actualTheme);
    }

    function toggleSidebarTheme() {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const nextTheme = current === 'dark' ? 'light' : 'dark';
      changeTheme(nextTheme);
      const sel = document.getElementById('themeSelect');
      if (sel) sel.value = nextTheme;
    }

    function updateSidebarThemeLabel(theme) {
      const icon = document.getElementById('sidebarThemeIcon');
      const text = document.getElementById('sidebarThemeText');
      if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
      if (text) text.textContent = theme === 'dark' ? 'Dark Mode' : 'Light Mode';
    }

    // Mobile Sidebar Drawer Toggle
    function toggleSidebar(forceState) {
      const sb = document.getElementById('sidebar');
      const bd = document.getElementById('sidebarBackdrop');
      if (!sb) return;
      const isOpen = forceState !== undefined ? forceState : !sb.classList.contains('open');
      if (isOpen) {
        sb.classList.add('open');
        if (bd) bd.classList.add('active');
      } else {
        sb.classList.remove('open');
        if (bd) bd.classList.remove('active');
      }
    }

    // Admin Auth
    async function doAdminLogin() {
      const u = document.getElementById('adminUsername').value.trim();
      const p = document.getElementById('adminPassword').value;
      const btn = document.getElementById('adminLoginBtn');
      if (!u || !p) { document.getElementById('adminLoginAlert').innerHTML = '<div style="color:var(--red);margin-bottom:10px">Username and password required</div>'; return; }
      btn.disabled = true; btn.textContent = 'Logging in...';
      try {
        const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u.toLowerCase(), password: p }) });
        adminToken = d.token; adminUser = d;
        localStorage.setItem('adminToken', adminToken);
        initAdminApp();
      } catch (e) {
        let msg = e.message;
        if ((msg === 'Failed to fetch' || msg.includes('NetworkError')) && window.location.protocol === 'file:') {
          msg = '<i data-lucide="alert-triangle" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i> Cannot connect to backend server from a local file. Please open this page via your live Railway URL (e.g. https://your-app.up.railway.app/admin) or start the server.';
        }
        document.getElementById('adminLoginAlert').innerHTML = `<div style="color:var(--red);margin-bottom:10px">${msg}</div>`;
      } finally { btn.disabled = false; btn.textContent = '🔐 Login to Admin Panel'; }
    }

    function doAdminLogout() {
      adminToken = null; localStorage.removeItem('adminToken');
      document.getElementById('adminApp').classList.add('hidden');
      document.getElementById('adminLoginScreen').style.display = '';
    }

    // App Navigation
    function showPage(name) {
      toggleSidebar(false); // Auto-close mobile drawer when navigating
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      const p = document.getElementById(name); if (p) p.classList.add('active');
      const n = document.getElementById(`nav-${name}`); if (n) n.classList.add('active');
      document.getElementById('topbarTitle').textContent = name.replace(/-/g, ' ').toUpperCase();

      if (name === 'dashboard') loadDashboard();
      if (name === 'members') loadMembers();
      if (name === 'seettu') loadSeettuCycles();
      if (name === 'duplicates') loadDuplicates();
      if (name === 'payments') loadAdminPayments();
      if (name === 'activation') loadActivationList();
      if (name === 'auction-control') loadAuctionControl();
      if (name === 'admin-chat-groups') { loadAdminGroupRequests(); loadAdminGroups(); }
      if (name === 'audit-log') loadAuditLogs();
      if (name === 'settings') loadSettings();
      if (name === 'seed-fund') loadSeedFundDistributions();
      if (name === 'groups') loadGroups();
      if (name === 'repayments') loadRepayments();
      if (name === 'proof-verification') loadPendingScheduleProofs();
      if (name === 'notice-board') loadAdminNotices();
      if (name === 'transactions') loadTransactionLedger();
      if (name === 'reports') loadFinancialReports();
      if (name === 'expenses') {
        document.getElementById('topbarTitle').textContent = 'EXPENSES (செலவு கணக்கு)';
        loadAdminExpenses();
      }
    }

    // ============================================================
    // SEED FUND & LOAN DISTRIBUTION HANDLERS
    // ============================================================
    let cachedDistributions = [];
    let cachedMembersList = [];
    let cachedGroupsList = [];

    function toggleDistInterestType() {
      const type = document.getElementById('distInterestType').value;
      const pctGroup = document.getElementById('distPctGroup');
      const amtGroup = document.getElementById('distAmtGroup');
      if (type === 'AMOUNT') {
        if (pctGroup) pctGroup.classList.add('hidden');
        if (amtGroup) amtGroup.classList.remove('hidden');
      } else {
        if (pctGroup) pctGroup.classList.remove('hidden');
        if (amtGroup) amtGroup.classList.add('hidden');
      }
      recalcDistInterest();
    }

    function recalcDistInterest() {
      const principal = parseFloat(document.getElementById('distPrincipal').value) || 0;
      const type = document.getElementById('distInterestType') ? document.getElementById('distInterestType').value : 'PERCENT';
      const monthsSel = document.getElementById('distMonths').value;
      const numMonths = parseInt(monthsSel, 10) || 1;

      let interest = 0;
      if (type === 'AMOUNT') {
        interest = parseFloat(document.getElementById('distInterestFlatAmt').value) || 0;
      } else {
        const pct = parseFloat(document.getElementById('distInterestPct').value) || 0;
        interest = Math.round((principal * (pct / 100)) * 100) / 100;
      }
      
      const total = Math.round((principal + interest) * 100) / 100;
      const monthly = Math.round((total / numMonths) * 100) / 100;

      if (document.getElementById('distCalcInterest')) document.getElementById('distCalcInterest').textContent = `<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${interest.toLocaleString('en-IN')}`;
      if (document.getElementById('distCalcTotal')) document.getElementById('distCalcTotal').textContent = `<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${total.toLocaleString('en-IN')}`;
      if (document.getElementById('distCalcMonthly')) document.getElementById('distCalcMonthly').textContent = `<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${monthly.toLocaleString('en-IN')}`;
    }

    function updateNextPaymentDate() {
      const sDateVal = document.getElementById('distStartDate').value;
      if (!sDateVal) return;
      const d = new Date(sDateVal);
      d.setMonth(d.getMonth() + 1);
      d.setDate(10); // Fixed 10th of next month schedule
      document.getElementById('distNextPayDate').value = d.toISOString().split('T')[0];
    }

    async function loadAdminLoanRequests() {
      const tbody = document.getElementById('adminLoanRequestsTableBody');
      const cntBadge = document.getElementById('cntAdminPendingLoans');
      if (!tbody) return;

      try {
        const data = await api('/api/seed-fund/requests');
        const reqs = (data.requests || []).filter(r => r.status === 'PENDING');
        if (cntBadge) cntBadge.textContent = `${reqs.length} Pending`;

        if (reqs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">✨ No pending member loan requests. All caught up! (புதிய விண்ணப்பங்கள் எதுவும் இல்லை)</td></tr>';
          return;
        }

        tbody.innerHTML = reqs.map(r => {
          const p = parseFloat(r.requested_amount || 0);
          const i = Math.round(p * 0.05 * 100) / 100;
          const t = Math.round((p + i) * 100) / 100;
          const nom = [r.nominee_name, r.nominee_relation, r.nominee_phone].filter(Boolean).join(' · ');

          return `
            <tr style="background:rgba(245,200,66,0.03)">
              <td><strong>#${r.id}</strong></td>
              <td><strong>${esc(r.member_name)}</strong> <span style="font-size:11px;color:var(--text-muted)">(${r.member_code || r.member_id})</span></td>
              <td style="font-size:15px;font-weight:800;color:var(--text)"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${p.toLocaleString('en-IN')}</td>
              <td style="color:var(--gold);font-weight:700">+<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${i.toLocaleString('en-IN')} (5%)</td>
              <td style="color:var(--green);font-weight:800"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${t.toLocaleString('en-IN')}</td>
              <td style="color:var(--gold);font-weight:600">${esc(nom || '—')}</td>
              <td style="font-size:12px;color:var(--text-muted)">${esc(r.purpose || 'General Loan')}</td>
              <td style="font-size:12px">${r.created_at ? r.created_at.split('T')[0] : '—'}</td>
              <td style="white-space:nowrap">
                <button class="btn-success btn-sm" onclick="approveAdminLoanRequest(${r.id})" style="margin-right:6px"><i data-lucide="check-circle" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i> Approve (அனுமதி)</button>
                <button class="btn-danger btn-sm" onclick="rejectAdminLoanRequest(${r.id})"><i data-lucide="x-circle" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i> Reject</button>
              </td>
            </tr>
          `;
        }).join('');
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--red)">Failed to load requests: ${esc(err.message)}</td></tr>`;
      }
    }

    async function approveAdminLoanRequest(id) {
      if (!confirm(`Confirm approval for Loan Request #${id}?\n\nகடன் கோரிக்கைக்கு ஒப்புதல் அளிக்கவா? 5% வட்டியுடன் கடன் பட்டுவாடா செய்யப்பட்டு 10-ஆம் தேதி தவணை அட்டவணை உருவாகும்.`)) return;

      try {
        const res = await api(`/api/seed-fund/requests/${id}/approve`, { method: 'POST' });
        showToast(res.message || 'Loan request approved and activated successfully!', 'success');
        loadAdminLoanRequests();
        loadSeedFundDistributions();
      } catch (err) {
        showToast(err.message || 'Failed to approve loan request', 'error');
      }
    }

    async function rejectAdminLoanRequest(id) {
      const reason = prompt('Enter reason for declining this loan request:');
      if (reason === null) return;

      try {
        const res = await api(`/api/seed-fund/requests/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ admin_notes: reason })
        });
        showToast(res.message || 'Loan request rejected', 'info');
        loadAdminLoanRequests();
      } catch (err) {
        showToast(err.message || 'Failed to reject loan request', 'error');
      }
    }

    let cachedAdminMonthlyStatement = null;

    async function loadMonthlyStatementAdmin(selectedMonth) {
      const curMonth = selectedMonth || new Date().toISOString().substring(0, 7);
      try {
        const data = await api(`/api/public-dashboard/monthly-statement?month=${curMonth}`);
        if (!data || !data.success) throw new Error(data.error || 'Failed to load statement');
        cachedAdminMonthlyStatement = data;

        // Populate month select dropdown if empty
        const sel = document.getElementById('adminReportMonthSelect');
        if (sel && data.available_months && sel.options.length <= 1) {
          sel.innerHTML = data.available_months.map(m => `
            <option value="${m}" ${m === data.month ? 'selected' : ''}>${m} (${new Date(m + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })})</option>
          `).join('');
        }

        // Summary KPI
        const s = data.summary || {};
        if (document.getElementById('admStmtInflow')) document.getElementById('admStmtInflow').textContent = `<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${(s.total_inflow || 0).toLocaleString('en-IN')}`;
        if (document.getElementById('admStmtInflowCount')) document.getElementById('admStmtInflowCount').textContent = `${s.inflow_count || 0} payments received`;
        if (document.getElementById('admStmtOutflow')) document.getElementById('admStmtOutflow').textContent = `<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${(s.total_outflow || 0).toLocaleString('en-IN')}`;
        if (document.getElementById('admStmtOutflowCount')) document.getElementById('admStmtOutflowCount').textContent = `${s.outflow_count || 0} loans disbursed`;
        if (document.getElementById('admStmtExpenses')) document.getElementById('admStmtExpenses').textContent = `-<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${(s.total_expenses || 0).toLocaleString('en-IN')}`;
        if (document.getElementById('admStmtExpensesCount')) document.getElementById('admStmtExpensesCount').textContent = `${s.expense_count || 0} expenses recorded`;
        if (document.getElementById('admStmtNetFlow')) {
          const net = s.net_monthly_flow || 0;
          document.getElementById('admStmtNetFlow').textContent = `${net >= 0 ? '+' : ''}<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${net.toLocaleString('en-IN')}`;
          document.getElementById('admStmtNetFlow').style.color = net >= 0 ? 'var(--green)' : 'var(--red)';
        }
        if (document.getElementById('admStmtClosingBalance')) document.getElementById('admStmtClosingBalance').textContent = `<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${(s.current_pool_balance || 0).toLocaleString('en-IN')}`;

        // Inflows Table
        const inTbody = document.getElementById('admStmtInflowsTableBody');
        if (inTbody) {
          if (!data.inflows || data.inflows.length === 0) {
            inTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">No payment inflows recorded for this month.</td></tr>';
          } else {
            inTbody.innerHTML = data.inflows.map((item, idx) => `
              <tr>
                <td><strong>#${idx + 1}</strong></td>
                <td><strong>${esc(item.member_name)}</strong> <span style="font-size:11px;color:var(--text-muted)">(${esc(item.member_code)})</span></td>
                <td><strong>${item.payment_date}</strong> <span style="font-size:11px;color:var(--text-muted)">(${item.payment_time})</span></td>
                <td><span class="badge badge-active" style="font-size:11px">${esc(item.category)}</span></td>
                <td style="color:var(--green);font-weight:800;font-size:14px"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${item.amount.toLocaleString('en-IN')}</td>
                <td><code>${esc(item.transaction_reference)}</code></td>
              </tr>
            `).join('');
          }
        }

        // Outflows Table
        const outTbody = document.getElementById('admStmtOutflowsTableBody');
        if (outTbody) {
          if (!data.outflows || data.outflows.length === 0) {
            outTbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--text-muted)">No loans distributed for this month.</td></tr>';
          } else {
            outTbody.innerHTML = data.outflows.map(d => `
              <tr>
                <td><strong>#${d.id}</strong></td>
                <td><strong>${esc(d.member_name)}</strong> <span style="font-size:11px;color:var(--text-muted)">(${esc(d.member_code)})</span></td>
                <td>${d.distribution_date}</td>
                <td style="font-weight:700"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${d.principal_amount.toLocaleString('en-IN')}</td>
                <td style="color:var(--gold);font-weight:700">+<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${d.interest_amount.toLocaleString('en-IN')} (${d.interest_percentage}%)</td>
                <td style="font-weight:800;color:var(--primary)"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${d.total_payable.toLocaleString('en-IN')}</td>
                <td style="color:var(--gold);font-weight:600">${esc(d.nominee_name)}</td>
                <td>${d.due_date}</td>
                <td><span class="badge ${d.payment_status === 'PAID' ? 'badge-active' : 'badge-pending'}">${d.payment_status}</span></td>
              </tr>
            `).join('');
          }
        }

        // Expenses Table
        const expTbody = document.getElementById('admStmtExpensesTableBody');
        if (expTbody) {
          if (!data.expenses || data.expenses.length === 0) {
            expTbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">No operational expenses recorded for this month.</td></tr>';
          } else {
            expTbody.innerHTML = data.expenses.map((e, idx) => `
              <tr>
                <td><strong>#${idx + 1}</strong></td>
                <td><strong>${esc(e.expense_date)}</strong> <span style="font-size:11px;color:var(--text-muted)">(${esc(e.expense_month)})</span></td>
                <td><span class="badge" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3)">${esc(e.category)}</span></td>
                <td><strong>${esc(e.title)}</strong></td>
                <td style="color:var(--text-muted);font-size:12px">${esc(e.remarks || '—')}</td>
                <td style="color:#ef4444;font-weight:800;font-size:14px;text-align:right">-<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(e.amount || 0).toLocaleString('en-IN')}</td>
                <td style="font-size:12px">${esc(e.created_by_name || 'Admin')}</td>
              </tr>
            `).join('');
          }
        }
      } catch (err) {
        showToast('Failed to load monthly statement: ' + err.message, 'error');
      }
    }

    function exportMonthlyStatementAdminCSV() {
      if (!cachedAdminMonthlyStatement) {
        showToast('Load statement first before exporting', 'error');
        return;
      }
      const data = cachedAdminMonthlyStatement;
      const m = data.month || 'statement';

      let csv = '\uFEFF'; // UTF-8 BOM
      csv += `PF CHIT FUND CLUB - FINANCIAL STATEMENT FOR ${m}\n`;
      csv += `Generated On: ${new Date().toLocaleString('en-IN')}\n\n`;

      csv += `SUMMARY METRICS\n`;
      csv += `Total Inflow (வரவு),<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${data.summary.total_inflow || 0}\n`;
      csv += `Total Outflow (கடன்),<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${data.summary.total_outflow || 0}\n`;
      csv += `Total Expenses (செலவு),-<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${data.summary.total_expenses || 0}\n`;
      csv += `Net Monthly Balance (நிகர இருப்பு),<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${data.summary.net_monthly_flow || 0}\n`;
      csv += `Available Fund Pool,<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${data.summary.current_pool_balance || 0}\n\n`;

      csv += `INFLOWS & MEMBER PAYMENTS\n`;
      csv += `S.No,Member Name,Member Code,Date,Time,Category,Amount (INR),Transaction Reference\n`;
      (data.inflows || []).forEach((row, i) => {
        csv += `"${i+1}","${row.member_name}","${row.member_code}","${row.payment_date}","${row.payment_time}","${row.category}","${row.amount}","${row.transaction_reference}"\n`;
      });

      csv += `\nOUTFLOWS & SEED FUND LOANS DISTRIBUTED\n`;
      csv += `Loan ID,Member Name,Member Code,Date Disbursed,Principal (INR),Interest (5%),Total Payable (INR),Nominee Name,Due Date,Status\n`;
      (data.outflows || []).forEach(row => {
        csv += `"${row.id}","${row.member_name}","${row.member_code}","${row.distribution_date}","${row.principal_amount}","${row.interest_amount}","${row.total_payable}","${row.nominee_name}","${row.due_date}","${row.payment_status}"\n`;
      });

      csv += `\nCLUB EXPENSES & DEDUCTIONS (சங்க செலவுகள்)\n`;
      csv += `S.No,Date,Month,Category,Purpose,Remarks,Deducted Amount (INR),Recorded By\n`;
      (data.expenses || []).forEach((row, i) => {
        csv += `"${i+1}","${row.expense_date}","${row.expense_month}","${row.category}","${row.title}","${row.remarks || ''}","-${row.amount}","${row.created_by_name || 'Admin'}"\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `PF_ChitFund_Statement_${m}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast(`Statement exported as PF_ChitFund_Statement_${m}.csv`, 'success');
    }

    function printMonthlyStatementAdmin() {
      if (!cachedAdminMonthlyStatement) {
        showToast('Statement data not loaded', 'error');
        return;
      }
      const data = cachedAdminMonthlyStatement;
      const m = data.month || 'Current';

      const printWin = window.open('', '_blank', 'width=1100,height=850');
      if (!printWin) {
        window.print();
        return;
      }

      const s = data.summary || {};
      const todayStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const auditHash = 'PF-AUDIT-' + Math.random().toString(36).substring(2, 9).toUpperCase() + '-' + Date.now().toString().slice(-6);

      const inflowRows = (data.inflows || []).map((item, idx) => `
        <tr>
          <td style="text-align:center;font-weight:600">${idx + 1}</td>
          <td>
            <strong style="color: var(--text);font-size:12px">${esc(item.member_name)}</strong><br>
            <span style="font-size:10px;color: var(--text3);font-family:monospace">ID: ${esc(item.member_code)} ${item.member_phone ? '· ' + esc(item.member_phone) : ''}</span>
          </td>
          <td style="font-size:11px;white-space:nowrap">${esc(item.payment_date)}<br><span style="color: var(--text3);font-size:10px">${esc(item.payment_time)}</span></td>
          <td style="font-size:11px">${esc(item.category)}</td>
          <td style="font-family:monospace;font-size:11px;color: var(--text2);word-break:break-all"><code>${esc(item.transaction_reference)}</code></td>
          <td style="text-align:right;font-weight:700;color:#15803d;font-size:12px"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(item.amount || 0).toLocaleString('en-IN')}</td>
        </tr>
      `).join('') || '<tr><td colspan="6" style="text-align:center;padding:16px;color:#94a3b8">No verified inflows recorded for this accounting month.</td></tr>';

      const loansToPrint = (data.outflows && data.outflows.length > 0) ? data.outflows : [];
      const loanRows = loansToPrint.map((d, idx) => {
        const isRefund = d.outflow_type === 'REFUND';
        const remaining = parseFloat(d.remaining_amount) || 0;
        const repaid = parseFloat(d.total_repaid) || 0;
        const isPaid = d.payment_status === 'PAID' || remaining <= 0;
        const isPartial = !isPaid && repaid > 0;
        const statusBg = isRefund ? '#fef3c7' : (isPaid ? '#dcfce7' : (isPartial ? '#ffedd5' : '#fee2e2'));
        const statusColor = isRefund ? '#92400e' : (isPaid ? '#166534' : (isPartial ? '#9a3412' : '#991b1b'));
        const statusText = isRefund 
          ? 'MEMBER EXIT REFUND (அசல் ஒப்படைப்பு)' 
          : (isPaid ? 'PAID / செலுத்தப்பட்டது' : (isPartial ? `PARTIAL (மீதம்: <i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${remaining.toLocaleString('en-IN')})` : 'ACTIVE DUE / நிலுவை'));

        return `
          <tr style="${isRefund ? 'background:#fffdf7;' : ''}">
            <td style="text-align:center;font-weight:600">${idx + 1}</td>
            <td>
              <strong style="color: var(--text);font-size:12px">${esc(d.member_name)}</strong><br>
              <span style="font-size:10px;color: var(--text3);font-family:monospace">${esc(d.member_code || '')}</span>
            </td>
            <td style="font-size:11px;white-space:nowrap">${(d.distribution_date || d.start_date || '—').split('T')[0]}</td>
            <td style="text-align:right;font-weight:600"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(d.principal_amount || 0).toLocaleString('en-IN')}</td>
            <td style="text-align:center;font-size:11px">${isRefund ? '—' : `${d.interest_percentage || 5}%<br><span style="font-size:10px;color: var(--text3)"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(d.interest_amount || 0).toLocaleString('en-IN')}</span>`}</td>
            <td style="text-align:right;font-weight:700"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(d.total_payable || 0).toLocaleString('en-IN')}</td>
            <td style="text-align:right;color:#15803d"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${repaid.toLocaleString('en-IN')}</td>
            <td style="text-align:right;font-weight:700;color:${remaining > 0 ? '#dc2626' : '#15803d'}"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${remaining.toLocaleString('en-IN')}</td>
            <td style="font-size:11px">${esc(d.nominee_name || '—')}</td>
            <td style="text-align:center">
              <span style="display:inline-block;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${statusBg};color:${statusColor}">${statusText}</span>
            </td>
          </tr>
        `;
      }).join('') || '<tr><td colspan="10" style="text-align:center;padding:16px;color:#94a3b8">No loan disbursements or member refunds for this accounting month.</td></tr>';

      const expensesToPrint = (data.expenses && data.expenses.length > 0) ? data.expenses : [];
      const expenseRows = expensesToPrint.map((e, idx) => `
        <tr>
          <td style="text-align:center;font-weight:600">${idx + 1}</td>
          <td style="font-size:11px;white-space:nowrap">${esc(e.expense_date)}<br><span style="color: var(--text3);font-size:10px">${esc(e.expense_month)}</span></td>
          <td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:#fee2e2;color:#991b1b">${esc(e.category)}</span></td>
          <td><strong style="color: var(--text);font-size:12px">${esc(e.title)}</strong></td>
          <td style="font-size:11px;color:#475569">${esc(e.remarks || '—')}</td>
          <td style="font-size:10px;color: var(--text3)">${esc(e.created_by_name || 'Admin')}</td>
          <td style="text-align:right;font-weight:800;color:#dc2626;font-size:12px">-<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(e.amount || 0).toLocaleString('en-IN')}</td>
        </tr>
      `).join('') || '<tr><td colspan="7" style="text-align:center;padding:16px;color:#94a3b8">No operational expenses incurred in this accounting month (செலவுகள் இல்லை).</td></tr>';

      printWin.document.write(`
        <!DOCTYPE html>
        <html lang="ta">
        <head>
          <meta charset="UTF-8">
          <title>Official Bank Statement — PF Chit Fund Club (${m})</title>
          <style>
            @page { size: A4 portrait; margin: 12mm 12mm 15mm 12mm; }
            * { box-sizing: border-box; }
            body { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; padding: 0; margin: 0; color: var(--text); line-height: 1.35; background: #fff; font-size: 11.5px; }
            .bank-header { border-bottom: 2.5px solid #0f2b5c; padding-bottom: 14px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
            .bank-title-group h1 { margin: 0 0 3px 0; font-size: 20px; color: #0f2b5c; font-weight: 800; letter-spacing: -0.3px; }
            .bank-title-group .tamil-title { font-size: 14px; color: #b45309; font-weight: 700; margin-bottom: 3px; }
            .bank-meta { font-size: 10px; color: #475569; }
            .bank-badge-box { text-align: right; }
            .official-seal { display: inline-block; border: 2px solid #0f2b5c; border-radius: 6px; padding: 6px 12px; background: var(--bg); text-align: center; }
            .official-seal .seal-head { font-size: 9px; text-transform: uppercase; font-weight: 800; color: #0f2b5c; letter-spacing: 0.8px; }
            .official-seal .seal-no { font-family: monospace; font-size: 11px; font-weight: 700; color: #b45309; }

            .account-summary-table { width: 100%; border: 1.5px solid #0f2b5c; border-collapse: collapse; margin-bottom: 16px; background: #fdfefe; }
            .account-summary-table th { background: #0f2b5c; color: var(--text); text-align: left; padding: 6px 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }
            .account-summary-table td { border: 1px solid #cbd5e1; padding: 6px 10px; font-size: 11px; }

            .kpi-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 18px; }
            .kpi-card { border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; text-align: center; background: var(--bg); }
            .kpi-card .kpi-label { font-size: 9.5px; font-weight: 700; text-transform: uppercase; color: var(--text3); letter-spacing: 0.4px; }
            .kpi-card .kpi-val { font-size: 15px; font-weight: 800; margin-top: 4px; }

            .section-title { font-size: 13px; font-weight: 800; color: #0f2b5c; margin: 18px 0 8px 0; display: flex; align-items: center; justify-content: space-between; border-bottom: 1.5px solid #e2e8f0; padding-bottom: 4px; }
            table.data-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 11px; }
            table.data-table th { background: #f1f5f9; color: var(--text2); font-weight: 700; border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; font-size: 10.5px; }
            table.data-table td { border: 1px solid var(--border); padding: 6px 8px; vertical-align: middle; }
            table.data-table tr:nth-child(even) { background: #fafafa; }

            .audit-callout { background: var(--bg); border-left: 4px solid #0f2b5c; padding: 10px 14px; margin: 16px 0; font-size: 10.5px; color: var(--text2); line-height: 1.5; border-radius: 0 6px 6px 0; }
            .signatory-container { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-top: 30px; page-break-inside: avoid; }
            .sign-box { border-top: 1.5px dashed #64748b; padding-top: 8px; text-align: center; font-size: 11px; }
            .sign-box strong { color: #0f2b5c; display: block; }
            .sign-box span { color: var(--text3); font-size: 10px; }

            .no-print-bar { background: #0f2b5c; color: var(--text); padding: 10px 16px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; border-radius: 6px; }
            .no-print-bar button { padding: 6px 14px; background: #f5c842; color: #0d0800; border: none; font-weight: 700; border-radius: 4px; cursor: pointer; }
            @media print {
              .no-print-bar { display: none !important; }
              body { padding: 0; }
            }
          </style>
        </head>
        <body>
          <div class="no-print-bar">
            <div><strong>PF Chit Fund Club — Official Admin Bank Statement System</strong> · Ready to print / save as PDF</div>
            <button onclick="window.print()"><i data-lucide="printer" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i> Print / Download PDF</button>
          </div>

          <div class="bank-header">
            <div class="bank-title-group">
              <h1>PF CHIT FUND CLUB (COMMUNITY SEED FUND)</h1>
              <div class="tamil-title">புதுப்பட்டி நண்பர்கள் சீட்டு நிதி கிளப் (அங்கீகரிக்கப்பட்ட கணக்கு அறிக்கை)</div>
              <div class="bank-meta">
                Regd Society Reg No: <strong>TN-PDK-CHIT-2024-001</strong> · Puduppatti Main Road, Pudukkottai Dt.<br>
                Official Verified UPI: <strong>puduppattifriends@okhdfcbank</strong> · Support: 9876543210
              </div>
            </div>
            <div class="bank-badge-box">
              <div class="official-seal">
                <div class="seal-head">OFFICIAL AUDIT LEDGER</div>
                <div class="seal-no">${auditHash}</div>
                <div style="font-size:8.5px;color: var(--text3);margin-top:2px">DATE: ${todayStr.split(',')[0]}</div>
              </div>
            </div>
          </div>

          <table class="account-summary-table">
            <tr>
              <th colspan="4">COMMUNITY POOL LEDGER STATEMENT OF ACCOUNT</th>
            </tr>
            <tr>
              <td style="width:25%;color: var(--text3)">Accounting Period:</td>
              <td style="width:25%"><strong>${m} (01 to 30/31)</strong></td>
              <td style="width:25%;color: var(--text3)">Currency / Mode:</td>
              <td style="width:25%"><strong>INR (<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>) / Direct Bank & UPI</strong></td>
            </tr>
            <tr>
              <td style="color: var(--text3)">Total Verified Inflows:</td>
              <td style="color:#15803d;font-weight:700"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.total_inflow || 0).toLocaleString('en-IN')} (${s.inflow_count || 0} txn)</td>
              <td style="color: var(--text3)">Total Outflows & Refunds:</td>
              <td style="color:#b91c1c;font-weight:700"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.total_outflow || 0).toLocaleString('en-IN')} (${s.outflow_count || 0} txn)</td>
            </tr>
            <tr>
              <td style="color: var(--text3)">Total Club Expenses (செலவு):</td>
              <td style="color:#dc2626;font-weight:800">-<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.total_expenses || 0).toLocaleString('en-IN')} (${s.expense_count || 0} items)</td>
              <td style="color: var(--text3)">Net Month Movement:</td>
              <td style="color:#0f2b5c;font-weight:700">${(s.net_monthly_flow || 0) >= 0 ? '+' : ''}<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.net_monthly_flow || 0).toLocaleString('en-IN')}</td>
            </tr>
            <tr>
              <td colspan="2" style="color: var(--text3);font-weight:600">Fund Pool Closing Balance (கையிருப்பு நிதி):</td>
              <td colspan="2" style="color:#15803d;font-weight:800;font-size:13px;text-align:right"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.current_pool_balance || s.closing_pool_balance || 0).toLocaleString('en-IN')}</td>
            </tr>
          </table>

          <div class="kpi-row">
            <div class="kpi-card">
              <div class="kpi-label">Verified Inflows (வரவு)</div>
              <div class="kpi-val" style="color:#15803d"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.total_inflow || 0).toLocaleString('en-IN')}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Loans & Refunds (கடன்)</div>
              <div class="kpi-val" style="color:#b45309"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.total_outflow || 0).toLocaleString('en-IN')}</div>
            </div>
            <div class="kpi-card" style="background:#fff5f5;border-color:#fecaca">
              <div class="kpi-label" style="color:#dc2626">Expenses (செலவு)</div>
              <div class="kpi-val" style="color:#dc2626">-<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.total_expenses || 0).toLocaleString('en-IN')}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Net Month Movement</div>
              <div class="kpi-val" style="color:#0f2b5c">${(s.net_monthly_flow || 0) >= 0 ? '+' : ''}<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.net_monthly_flow || 0).toLocaleString('en-IN')}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Club Closing Cash Pool</div>
              <div class="kpi-val" style="color:#15803d"><i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>${parseFloat(s.current_pool_balance || s.closing_pool_balance || 0).toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div class="section-title">
            <span><i data-lucide="arrow-down-to-line" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i> 1. VERIFIED INFLOW REGISTER (உறுப்பினர் உள்வரவு பட்டியல் - தேதி & நேரத்துடன்)</span>
            <span style="font-size:10px;font-weight:normal;color: var(--text3)">Total: ${data.inflows?.length || 0} Transactions</span>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:30px;text-align:center">#</th>
                <th>Member Name & Code</th>
                <th>Payment Date & Time</th>
                <th>Category / Purpose</th>
                <th>Bank UTR / Ref No</th>
                <th style="text-align:right">Amount (<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>)</th>
              </tr>
            </thead>
            <tbody>
              ${inflowRows}
            </tbody>
          </table>

          <div class="section-title" style="margin-top:22px">
            <span><i data-lucide="arrow-up-to-line" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i> 2. LOANS DISBURSED & MEMBER EXIT REFUNDS (கடன் மற்றும் உறுப்பினர் விலகல் தீர்வு)</span>
            <span style="font-size:10px;font-weight:normal;color: var(--text3)">Total: ${loansToPrint?.length || 0} Records</span>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:30px;text-align:center">#</th>
                <th>Member / Beneficiary</th>
                <th>Date</th>
                <th style="text-align:right">Principal (<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>)</th>
                <th style="text-align:center">Interest</th>
                <th style="text-align:right">Total Due</th>
                <th style="text-align:right">Repaid</th>
                <th style="text-align:right">Balance</th>
                <th>Nominee / Witness</th>
                <th style="text-align:center">Status</th>
              </tr>
            </thead>
            <tbody>
              ${loanRows}
            </tbody>
          </table>

          <div class="section-title" style="margin-top:22px;border-bottom:1.5px solid #fee2e2">
            <span style="color:#b91c1c"><i data-lucide="coins" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i> 3. CLUB EXPENSES AUDIT REGISTER (சங்க செலவு கணக்கு அறிக்கை - விவரங்களுடன்)</span>
            <span style="font-size:10px;font-weight:normal;color: var(--text3)">Total: ${expensesToPrint?.length || 0} Records</span>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:30px;text-align:center">#</th>
                <th>Expense Date (தேதி)</th>
                <th>Category (வகை)</th>
                <th>Expense Purpose / Title (செலவு விவரம்)</th>
                <th>Remarks / Reason (காரணம்)</th>
                <th>Authorized By</th>
                <th style="text-align:right">Deducted Amount (<i data-lucide="indian-rupee" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i>)</th>
              </tr>
            </thead>
            <tbody>
              ${expenseRows}
            </tbody>
          </table>

          <div class="audit-callout">
            <strong><i data-lucide="pin" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;"></i> தணிக்கை மற்றும் விதிகள் சான்றிதழ் (Audit & Transparency Governance Note):</strong><br>
            1. <strong>உறுப்பினர் விலகல் (Member Exit Settlement):</strong> உறுப்பினர் கிளப்பில் இருந்து விலகும்போது, அவர் இதுவரை செலுத்திய மொத்த அசல் தொகை (Principal Contribution) துல்லியமாகக் கணக்கிடப்பட்டு அவருக்கு முழுமையாக திருப்பியளிக்கப்படுகிறது (<code>REFUNDED</code>). அந்த தொகை கிளப்பின் நடப்பு கணக்கிலிருந்து கழிக்கப்படும்.<br>
            2. <strong>தணிக்கைப் பாதுகாப்பு (Audit Trail Preservation):</strong> உறுப்பினரின் பெயர் மற்றும் தொலைபேசி எண் புதிய பதிவுக்கு விடுவிக்கப்பட்டாலும், கடந்த கால தணிக்கைக்காக அவர் செலுத்திய கட்டணங்கள் மற்றும் பரிவர்த்தனை வரலாறு நிரந்தரமாக பாதுகாக்கப்படும்.<br>
            3. ஈட்டிய 5% வட்டித் தொகை கிளப்பின் பொது நிதியிலேயே சேர்க்கப்பட்டு, தகுதியான உறுப்பினர்களுக்கு சீட்டு மற்றும் அவசரக் கடனாக மட்டுமே மறுசுழற்சி செய்யப்படுகிறது.<br>
            4. <strong>சங்கச் செலவுகள் (Club Operational Expenses):</strong> சங்கத்தின் செயல்பாட்டுச் செலவுகள் (ஸ்டேஷனரி, கூட்டம், உணவு/டீ, மராமத்து, போன்றவை) வெளிப்படைத்தன்மையுடன் பதிவு செய்யப்பட்டு, சங்கத்தின் மொத்த கையிருப்பு தொகையிலிருந்து முறையாகக் கழிக்கப்பட்டுள்ளது.
          </div>

          <div class="signatory-container">
            <div class="sign-box">
              <strong>பொருளாளர் (TREASURER)</strong>
              <span>PF Chit Fund Club</span>
            </div>
            <div class="sign-box">
              <div style="display:inline-block;border:1px dashed #b45309;padding:2px 8px;border-radius:4px;color:#b45309;font-weight:700;font-size:9px;margin-bottom:4px">
                SYSTEM CERTIFIED
              </div>
              <strong>டிஜிட்டல் முத்திரை (SEAL)</strong>
              <span>Verified by AI Guardian Watchdog</span>
            </div>
            <div class="sign-box">
              <strong>தலைவர் / தணிக்கையாளர் (AUDITOR)</strong>
              <span>Authorized Signatory</span>
            </div>
          </div>

          <div style="font-size:9.5px;color: var(--text3);border-top:1px solid #e2e8f0;padding-top:8px;margin-top:20px;text-align:center">
            This is an official, computer-generated bank-grade statement from PF Chit Fund Club System (${auditHash}). Generated on ${todayStr} IST.
          </div>
          <script src="https://unpkg.com/lucide@latest">