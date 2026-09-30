// Friends Included — website client. Every action is sent to /api/action and
// decided by the server's processing layer; the UI never decides permissions.
import * as R from '/shared/rules.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v) => R.formatEuro(v);
const eurC = (c) => R.formatEuro(c, { cents: true });
const pct = (v) => (v === null || v === undefined ? '—' : R.formatPercent(R.toBp(v)));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

const EMPLOYEE_OPTIONS = [
  ['svetlana', 'Svetlana de Monte Carlo — Manager'],
  ['richard', 'Richard “Call Me Dick” Darling — Sales'],
  ['anastasia', 'Anastasia Ferrari — Sales'],
  ['jeanclaude', 'Jean-Claude Bērziņš — Sales'],
  ['kevin', 'Kevin von Whatever — Expenses'],
];
const ROLE_HINT = {
  svetlana: 'Sees everything · approves sales, splits and allocations',
  richard: 'Submits sales and proposed splits · sees own records',
  anastasia: 'Submits sales and proposed splits · sees own records',
  jeanclaude: 'Submits sales and proposed splits · sees own records',
  kevin: 'Submits expenses and proposed allocations · sees own records',
};

const S = {
  role: store.get('fi-role', 'svetlana'),
  tab: null,
  config: null,
  data: null,
  filter: 'all',
  open: new Set(),
  lastSubmit: null,
  selftest: null,
  ledger: null,
  probe: [],
};

// ---------------------------------------------------------------- api

async function api(path, { method = 'GET', body, role = S.role } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-demo-role': role },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}
const act = (body) => api('/api/action', { method: 'POST', body });

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 7000 : 4500);
}

async function load() {
  try {
    S.data = await api('/api/state');
  } catch (e) {
    S.data = null;
    $('#view').innerHTML = `<div class="card notice bad">Could not load data: ${esc(e.message)}</div>`;
    throw e;
  }
}

// ---------------------------------------------------------------- tabs

const isManager = () => S.data?.actor?.role === 'manager';
const TABS = [
  { id: 'dashboard', label: 'Dashboard', render: renderDashboard },
  { id: 'records', label: 'Records', render: renderRecords },
  { id: 'sale', label: 'New sale', render: renderSaleForm },
  { id: 'expense', label: 'New expense', render: renderExpenseForm },
  { id: 'approvals', label: 'Approvals', render: renderApprovals, count: () => pendingItems().length },
  { id: 'setup', label: 'Manager setup', render: renderSetup, manager: true },
  { id: 'ledger', label: 'Audit ledger', render: renderLedger, manager: true },
  { id: 'test', label: 'Acceptance test', render: renderTest },
  { id: 'guide', label: 'How to use', render: renderGuide },
];

function renderTabs() {
  const visible = TABS.filter((t) => !t.manager || isManager());
  if (!visible.some((t) => t.id === S.tab)) S.tab = 'dashboard';
  $('#tabs').innerHTML = visible.map((t) => {
    const n = t.count ? t.count() : 0;
    return `<button role="tab" data-tab="${t.id}" aria-selected="${t.id === S.tab}">${t.label}${n ? `<span class="count">${n}</span>` : ''}</button>`;
  }).join('');
  const bar = $('#tabs'); const active = $('[aria-selected="true"]', bar);
  if (active && (active.offsetLeft + active.offsetWidth > bar.scrollLeft + bar.clientWidth || active.offsetLeft < bar.scrollLeft)) {
    bar.scrollLeft = active.offsetLeft - 20;
  }
}

function render() {
  renderTabs();
  const tab = TABS.find((t) => t.id === S.tab);
  $('#view').innerHTML = tab.render();
  tab.after?.();
  afterRender[S.tab]?.();
}
const afterRender = {};

function go(tab) {
  S.tab = tab;
  if (tab === 'ledger') S.ledger = null; // always show the current chain
  store.set('fi-tab', tab);
  history.replaceState(null, '', `#${tab}`);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------- shared bits

const txs = () => S.data?.transactions || [];
const emp = (id) => S.data?.employees?.find((e) => e.id === id);
const shortName = (id) => emp(id)?.short || id;
const pendingItems = () => txs().filter((t) => t.status === 'pending' || t.status === 'awaiting_allocation');

const projectBadge = (p) => (p ? `<span class="badge ${p === 'A' ? 'a' : p === 'B' ? 'b' : 'oh'}">${p === 'OVERHEAD' ? 'Overhead' : `${p} · ${R.PROJECTS[p]}`}</span>` : '');
const allocBadge = (a) => `<span class="badge ${a === 'A' ? 'a' : a === 'B' ? 'b' : 'oh'}">${a === 'OVERHEAD' ? 'Company overhead' : `${a} · ${R.PROJECTS[a]}`}</span>`;

function statusBadge(t) {
  if (t.status === 'pending') return '<span class="badge warn">Pending approval</span>';
  if (t.status === 'awaiting_allocation') return '<span class="badge warn">Awaiting allocation</span>';
  if (t.kind === 'expense' && !t.decided_by) return '<span class="badge ok">Allocated automatically</span>';
  return `<span class="badge ok">${t.kind === 'sale' ? 'Approved' : 'Allocated'}</span>${t.changed ? ' <span class="badge info">changed by manager</span>' : ''}`;
}

function sheetBadge(t) {
  const retry = isManager() ? ` <button class="btn ghost sm" data-retry-sheet="${esc(t.reference)}">Retry</button>` : '';
  if (t.sheet_status === 'synced') return '<span class="badge ok">✓ Synced</span>';
  if (t.sheet_status === 'failed') return `<span class="badge bad" title="${esc(t.sheet_error)}">Sync failed</span>${retry}`;
  return `<span class="badge warn">Sync pending</span>${retry}`;
}

function notifyBadge(t) {
  const retry = isManager() ? ` <button class="btn ghost sm" data-retry-notify="${esc(t.reference)}">Retry</button>` : '';
  switch (t.notify_status) {
    case 'sent': return '<span class="badge ok">✓ Sent</span>';
    case 'failed': return `<span class="badge bad" title="${esc(t.notify_error)}">Not delivered</span>${retry}`;
    case 'no_recipient': return `<span class="badge bad">No Telegram recipient linked</span>${retry}`;
    case 'not_required': return '<span class="badge info">Submission confirmation only</span>';
    case 'pending': return '<span class="badge warn">Sending…</span>';
    default: return '<span class="muted small">After decision</span>';
  }
}

function splitText(t, kind) {
  const v = SALES.map((p) => t[`${kind}_${p}`]);
  if (v.some((x) => x === null || x === undefined)) return '—';
  return v.map((x) => R.formatPercent(R.toBp(x)).replace('%', '')).join(' / ') + '%';
}
const SALES = R.SALESPEOPLE;

function recipientPreview(t) {
  if (t.source === 'telegram' && t.origin_chat_id) return `original Telegram chat <span class="mono">${esc(t.origin_chat_id)}</span>`;
  const e = emp(t.submitted_by);
  if (e?.telegram_chat_id) return `${esc(e.short)}’s linked chat <span class="mono">${esc(e.telegram_chat_id)}</span>`;
  return '<b>No Telegram recipient linked</b> (the record will say so)';
}

// ---------------------------------------------------------------- dashboard

function renderDashboard() {
  const d = S.data;
  if (!isManager()) {
    const mine = txs();
    const pend = mine.filter((t) => t.status === 'pending' || t.status === 'awaiting_allocation').length;
    return `
      <div class="card">
        <h2>Hello, ${esc(d.actor.short)}</h2>
        <p class="muted">You are acting as <b>${esc(d.actor.title)}</b>. Company financial results are visible to Svetlana only — the server refuses to send them to other roles.</p>
        <div class="grid g3 section-gap">
          <div class="card kpi"><div class="label">My submissions</div><div class="value">${mine.length}</div></div>
          <div class="card kpi"><div class="label">Waiting for Svetlana</div><div class="value">${pend}</div></div>
          <div class="card kpi"><div class="label">Decided</div><div class="value">${mine.length - pend}</div></div>
        </div>
        <p class="section-gap"><button class="btn" data-go="${d.actor.role === 'expenses' ? 'expense' : 'sale'}">${d.actor.role === 'expenses' ? 'Report an expense' : d.actor.role === 'sales' ? 'Report a sale' : 'Open records'}</button>
        <button class="btn ghost" data-go="records">My records</button></p>
      </div>`;
  }
  const r = d.results;
  const P = r.projects;
  const C = r.company;
  const cls = (c) => (c < 0 ? 'neg' : '');
  const pend = pendingItems();
  const attention = txs().filter((t) => t.sheet_status !== 'synced' || ['failed', 'no_recipient'].includes(t.notify_status));
  return `
    <div class="grid g4">
      <div class="card kpi hero"><div class="label">Company result</div><div class="value ${cls(C.result)}">${eurC(C.result)}</div><div class="sub">approved sales − commissions − all expenses</div></div>
      <div class="card kpi"><div class="label">Approved income</div><div class="value">${eurC(C.income)}</div><div class="sub">${r.pending.salesCount} sale(s) pending · ${eurC(r.pending.salesCents)} excluded</div></div>
      <div class="card kpi"><div class="label">Commission expense</div><div class="value">${eurC(C.commission)}</div><div class="sub">10% pool of approved sales</div></div>
      <div class="card kpi"><div class="label">Recorded expenses</div><div class="value">${eurC(C.expenses)}</div><div class="sub">overhead ${eurC(C.overhead)} · awaiting ${eurC(C.awaiting)}</div></div>
    </div>

    <div class="card section-gap">
      <div class="card-head"><h3>Financial results</h3><span class="muted small">Same layout as the homework brief · euros, no VAT</span></div>
      <div class="table-wrap"><table class="results-table">
        <thead><tr><th>Measure</th><th class="num col-a">Project A · Respectable Relatives</th><th class="num col-b">Project B · Drunk University Friends</th><th class="num">Company</th></tr></thead>
        <tbody>
          <tr><td>Approved income</td><td class="num">${eurC(P.A.income)}</td><td class="num">${eurC(P.B.income)}</td><td class="num">${eurC(C.income)}</td></tr>
          <tr><td>Commission expense</td><td class="num">${eurC(P.A.commission)}</td><td class="num">${eurC(P.B.commission)}</td><td class="num">${eurC(C.commission)}</td></tr>
          <tr><td>Allocated project expenses</td><td class="num">${eurC(P.A.expenses)}</td><td class="num">${eurC(P.B.expenses)}</td><td class="num">${eurC(C.allocatedExpenses)}</td></tr>
          <tr><td>Company overhead</td><td class="num muted">—</td><td class="num muted">—</td><td class="num">${eurC(C.overhead)}</td></tr>
          <tr><td>Expenses awaiting allocation</td><td class="num muted">—</td><td class="num muted">—</td><td class="num">${eurC(C.awaiting)}</td></tr>
          <tr class="total"><td>Result</td><td class="num ${cls(P.A.result)}">${eurC(P.A.result)}</td><td class="num ${cls(P.B.result)}">${eurC(P.B.result)}</td><td class="num ${cls(C.result)}">${eurC(C.result)}</td></tr>
        </tbody>
      </table></div>
    </div>

    <div class="grid g2 section-gap">
      <div class="card">
        <div class="card-head"><h3>Commission earned</h3><span class="muted small">approved sales only</span></div>
        ${commissionBars(r)}
      </div>
      <div class="card waterfall">
        <div class="card-head"><h3>Reconciliation bridge</h3>${r.reconciliation.ok ? '<span class="badge ok">✓ reconciles to the cent</span>' : '<span class="badge bad">does not reconcile</span>'}</div>
        ${waterfall(r)}
        <p class="muted small">Why do the project results not add up to the company result? Company overhead and expenses still awaiting allocation reduce the company result but belong to no project yet.</p>
      </div>
    </div>

    <div class="grid g2 section-gap">
      <div class="card">
        <div class="card-head"><h3>Waiting for your decision</h3><button class="btn ghost sm" data-go="approvals">Open approvals</button></div>
        ${pend.length ? `<table><tbody>${pend.map((t) => `<tr><td><b>${esc(t.reference)}</b></td><td>${t.kind === 'sale' ? `Sale · ${esc(t.customer)}` : `Expense · ${esc(t.description)}`}</td><td>${t.kind === 'sale' ? projectBadge(t.project) : allocBadge(t.proposed_allocation)}</td><td class="num">${eur(t.amount)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing pending. Svetlana may book a weekend in Monaco.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><h3>Delivery &amp; sync health</h3><button class="btn ghost sm" data-go="records" data-filter="attention">Show records</button></div>
        ${attention.length ? `<table><tbody>${attention.map((t) => `<tr><td><b>${esc(t.reference)}</b></td><td>${sheetBadge(t)}</td><td>${notifyBadge(t)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Every record is in Google Sheets and every decision notification was delivered.</div>'}
      </div>
    </div>`;
}

function commissionBars(r) {
  const total = SALES.reduce((s, p) => s + r.commissionBy[p], 0);
  const max = Math.max(1, ...SALES.map((p) => r.commissionBy[p]));
  return `<div class="bars">${SALES.map((p) => `
    <div class="bar"><span>${R.SALESPERSON_NAMES[p]}</span><div class="track"><div class="fill c-${p}" style="width:${(r.commissionBy[p] / max) * 100}%"></div></div><b class="num">${eurC(r.commissionBy[p])}</b></div>`).join('')}
    <div class="bar" style="border-top:1px solid var(--line);margin-top:4px;padding-top:10px"><b>Total</b><span></span><b class="num">${eurC(total)}</b></div>
  </div>`;
}

function waterfall(r) {
  const steps = [
    { label: 'Project A', delta: r.projects.A.result, color: 'var(--a)' },
    { label: 'Project B', delta: r.projects.B.result, color: 'var(--b)' },
    { label: 'Overhead', delta: -r.company.overhead, color: 'var(--gold)' },
    { label: 'Awaiting', delta: -r.company.awaiting, color: '#9a8f88' },
  ];
  let cum = 0;
  const bars = steps.map((s) => { const from = cum; cum += s.delta; return { ...s, from, to: cum }; });
  bars.push({ label: 'Company', from: 0, to: r.company.result, delta: r.company.result, color: 'var(--plum)', total: true });
  const vals = bars.flatMap((b) => [b.from, b.to]).concat(0);
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  const W = 520; const H = 230; const top = 26; const bottom = 36; const span = hi - lo || 1;
  const y = (v) => top + ((hi - v) / span) * (H - top - bottom);
  const bw = 64; const gap = (W - bars.length * bw) / (bars.length + 1);
  const short = (c) => { const e = c / 100; const a = Math.abs(e); const s = a >= 1000 ? `€${(a / 1000).toFixed(a >= 10000 ? 1 : 2)}k` : `€${a.toFixed(0)}`; return (e < 0 ? '−' : '') + s; };
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Waterfall from project results to company result"><line class="axis" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>`;
  bars.forEach((b, i) => {
    const x = gap + i * (bw + gap);
    const y1 = y(Math.max(b.from, b.to)); const h = Math.max(2, Math.abs(y(b.from) - y(b.to)));
    svg += `<rect x="${x}" y="${y1}" width="${bw}" height="${h}" rx="5" fill="${b.color}" opacity="${b.total ? 1 : 0.88}"/>`;
    svg += `<text class="val" x="${x + bw / 2}" y="${y1 - 7}" text-anchor="middle">${b.total ? short(b.to) : (b.delta >= 0 ? '+' : '') + short(b.delta)}</text>`;
    svg += `<text x="${x + bw / 2}" y="${H - 14}" text-anchor="middle">${b.label}</text>`;
    if (i < bars.length - 1 && !b.total) svg += `<line x1="${x + bw}" x2="${x + bw + gap}" y1="${y(b.to)}" y2="${y(b.to)}" stroke="#bbb" stroke-dasharray="3 3"/>`;
  });
  return `${svg}</svg>`;
}

// ---------------------------------------------------------------- records

function renderRecords() {
  const all = txs();
  const filters = [
    ['all', 'All'], ['sale', 'Sales'], ['expense', 'Expenses'], ['open', 'Pending'], ['attention', 'Needs attention'],
  ];
  const list = all.filter((t) => ({
    all: true, sale: t.kind === 'sale', expense: t.kind === 'expense',
    open: t.status === 'pending' || t.status === 'awaiting_allocation',
    attention: t.sheet_status !== 'synced' || ['failed', 'no_recipient'].includes(t.notify_status),
  }[S.filter])).reverse();
  return `
    <div class="card">
      <div class="card-head">
        <div><h3>${isManager() ? 'All transactions' : 'My submissions'}</h3><span class="muted small">${isManager() ? 'Svetlana sees every record' : `Only records submitted by ${esc(S.data.actor.short)} are sent by the server`} · click a row for details</span></div>
        <div class="chips">${filters.map(([k, l]) => `<button class="btn ${S.filter === k ? '' : 'ghost'} sm" data-filter="${k}">${l}</button>`).join('')}
          <button class="btn ghost sm" data-refresh>↻ Refresh</button></div>
      </div>
      ${list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Ref</th><th>Submitted</th><th>Details</th><th>Project / allocation</th><th class="num">Amount</th><th>Commission split R/A/J</th><th>Status</th><th>Google Sheets</th><th>Telegram</th></tr></thead>
        <tbody>${list.map(recordRow).join('')}</tbody></table></div>`
      : '<div class="empty"><div class="big">No records here yet</div>Use “New sale”, “New expense” or the Telegram bot.</div>'}
    </div>`;
}

function recordRow(t) {
  const open = S.open.has(t.reference);
  const alloc = t.kind === 'sale' ? projectBadge(t.project)
    : t.final_allocation && t.final_allocation !== t.proposed_allocation
      ? `<div class="chips"><s class="muted">${allocBadge(t.proposed_allocation)}</s> → ${allocBadge(t.final_allocation)}</div>`
      : allocBadge(t.final_allocation || t.proposed_allocation);
  const comm = t.kind === 'sale'
    ? `<div class="small">Proposed ${splitText(t, 'prop')}</div>${t.status === 'approved' ? `<div class="small"><b>Approved ${splitText(t, 'appr')}</b> · ${eur(t.commission_pool)}</div>` : '<div class="small muted">Earned €0.00 until approved</div>'}`
    : '<span class="muted">—</span>';
  const main = `<tr class="clickable" data-toggle="${esc(t.reference)}">
    <td><b>${esc(t.reference)}</b><div class="small muted">${t.kind === 'sale' ? 'Sale' : 'Expense'}</div></td>
    <td class="small when">${fmtTime(t.submitted_at)}<div class="muted">${esc(shortName(t.submitted_by))} · ${t.source === 'telegram' ? 'Telegram' : 'Website'}</div></td>
    <td class="small desc">${t.kind === 'sale' ? `<b>${esc(t.customer)}</b><div class="muted">${esc(t.description)}</div>` : `<b>${esc(t.category)}</b><div class="muted">${esc(t.description)}</div>`}</td>
    <td>${alloc}</td>
    <td class="num">${eur(t.amount)}</td>
    <td>${comm}</td>
    <td>${statusBadge(t)}</td>
    <td>${sheetBadge(t)}</td>
    <td>${notifyBadge(t)}</td>
  </tr>`;
  if (!open) return main;
  const parts = t.kind === 'sale' && t.status === 'approved'
    ? SALES.map((p) => `${R.SALESPERSON_NAMES[p]} ${pct(t[`appr_${p}`])} = ${eur(t[`comm_${p}`])}`).join(' · ') : '';
  return `${main}<tr class="detail"><td colspan="9">
    <div class="grid g2">
      <div class="small">
        <div><b>Submitted</b> ${new Date(t.submitted_at).toLocaleString('en-GB')} by ${esc(emp(t.submitted_by)?.name || t.submitted_by)} via ${t.source === 'telegram' ? `Telegram (chat <span class="mono">${esc(t.origin_chat_id)}</span>)` : 'website'}</div>
        ${t.decided_at ? `<div><b>Decision</b> ${new Date(t.decided_at).toLocaleString('en-GB')} ${t.decided_by ? `by ${esc(shortName(t.decided_by))}` : '(automatic overhead allocation)'}</div>` : ''}
        ${parts ? `<div><b>Commission</b> ${parts}</div>` : ''}
        ${t.kind === 'expense' ? `<div><b>Proposed allocation</b> ${esc(R.ALLOCATIONS[t.proposed_allocation])} · <b>Final</b> ${t.final_allocation ? esc(R.ALLOCATIONS[t.final_allocation]) : '— (awaiting)'}</div>` : ''}
        <div><b>Google Sheets</b> ${esc(t.sheet_status)}${t.sheet_row ? ` (row ${esc(t.sheet_row)})` : ''}${t.sheet_error ? ` — <span class="neg">${esc(t.sheet_error)}</span>` : ''}</div>
        <div><b>Telegram</b> ${esc(t.notify_status)}${t.notify_chat_id ? ` → chat <span class="mono">${esc(t.notify_chat_id)}</span>` : ''}${t.notify_error && t.notify_status !== 'sent' ? ` — <span class="neg">${esc(t.notify_error)}</span>` : ''}</div>
      </div>
      <div>${t.notify_text ? `<div class="small muted">Decision message${t.notify_status === 'sent' ? ' (delivered)' : ' (not delivered)'}</div><pre class="msg">${esc(t.notify_text)}</pre>` : '<div class="small muted">No decision message yet.</div>'}</div>
    </div></td></tr>`;
}

// ---------------------------------------------------------------- forms

function roleNotice(required) {
  const role = S.data.actor.role;
  if (role === required) return '';
  const what = required === 'sales' ? 'sales' : 'expenses';
  return `<div class="notice warn">You are acting as <b>${esc(S.data.actor.short)}</b>, who may not submit ${what}. The form stays available so you can see the <b>server</b> refuse it — permissions are enforced in the processing layer, not by hiding buttons.</div>`;
}

function confirmation() {
  if (!S.lastSubmit || S.lastSubmit.tab !== S.tab) return '';
  const { message, reference } = S.lastSubmit;
  return `<div class="card section-gap"><div class="card-head"><h3>Recorded ${esc(reference)}</h3><span class="badge ok">saved in Supabase</span></div><pre class="msg">${esc(message)}</pre></div>`;
}

function renderSaleForm() {
  return `
    <div class="grid g2">
      <form class="card form" id="sale-form" novalidate>
        <div class="card-head"><h3>Report a sale</h3><span class="muted small">Salesperson: <b>${esc(S.data.actor.short)}</b> (automatic)</span></div>
        ${roleNotice('sales')}
        <div class="row">
          <div class="field"><label for="s-ref">Reference</label><input id="s-ref" name="reference" placeholder="S03" required autocomplete="off"></div>
          <div class="field"><label for="s-amt">Amount (€)</label><input id="s-amt" name="amount" inputmode="decimal" placeholder="1500.00" required></div>
        </div>
        <div class="field"><label for="s-cust">Customer</label><input id="s-cust" name="customer" placeholder="Emma Stonebridge" required></div>
        <div class="field"><span class="label">Project</span>
          <div class="seg"><label><input type="radio" name="project" value="A" checked>A · Respectable Relatives</label><label><input type="radio" name="project" value="B">B · Drunk University Friends</label></div></div>
        <div class="field"><label for="s-desc">Description</label><input id="s-desc" name="description" placeholder="Premium relatives, including an uncle presented as a surgeon" required></div>
        <div class="field"><span class="label">Proposed commission split (must total 100%)</span>
          <div class="split-inputs">${SALES.map((p) => `<div class="field"><label for="s-${p}">${R.SALESPERSON_NAMES[p]} %</label><input id="s-${p}" name="${p}" inputmode="decimal" placeholder="0"></div>`).join('')}</div>
        </div>
        <div id="sale-preview"></div>
        <div><button class="btn" type="submit">Submit sale</button></div>
      </form>
      <div>
        <div class="card"><h3>How the commission works</h3>
          <p class="small">The pool is <b>10%</b> of the sale. The three shares divide the pool and must total exactly 100%. Amounts are rounded to cents; any leftover cent goes to the largest share (ties: Richard → Anastasia → Jean-Claude).</p>
          <p class="small">The sale is saved as <b>Pending approval</b>: it appears in the records but counts towards income and commission only after Svetlana approves it.</p>
          <p class="small muted">Same rules as the Telegram command:<br><code>/sale S03 | Emma Stonebridge | A | Premium relatives | 1500 | 40/40/20</code></p>
        </div>
        ${confirmation()}
      </div>
    </div>`;
}
afterRender.sale = () => {
  const f = $('#sale-form');
  const update = () => { $('#sale-preview').innerHTML = splitPreview(f.amount.value, readSplit(f)); };
  f.addEventListener('input', update);
  update();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = { reference: f.reference.value, customer: f.customer.value, project: f.project.value, description: f.description.value, amount: f.amount.value, split: readSplit(f) };
    await submitForm(f, { action: 'submitSale', data });
  });
};

function readSplit(f, prefix = '') {
  return Object.fromEntries(SALES.map((p) => [p, f[`${prefix}${p}`].value.trim() === '' ? '0' : f[`${prefix}${p}`].value]));
}

function splitPreview(amount, split, proposed = null) {
  const cents = R.parseAmountToCents(amount);
  let bp;
  try { bp = R.normaliseSplit(split); } catch (e) {
    return `<div class="notice warn">${esc(e.message)} The server will refuse it until it does.</div>`;
  }
  const bar = `<div class="stackbar">${SALES.map((p) => `<i class="c-${p}" style="width:${bp[p] / 100}%"></i>`).join('')}</div>`;
  if (!cents || Number.isNaN(cents) || cents <= 0) return `<div class="notice ok">Shares total 100% ✓ — enter an amount to preview euros.</div>${bar}`;
  const c = R.computeCommission(cents, bp);
  return `<div class="small muted">Commission pool ${eurC(c.pool)} (10% of ${eurC(cents)})${c.roundingCents ? ` · ${c.roundingCents} rounding cent(s) → ${R.SALESPERSON_NAMES[c.roundingTo]}` : ''}</div>
    <div class="preview">${SALES.map((p) => {
      const changed = proposed && proposed[p] !== bp[p];
      return `<div${changed ? ' style="outline:2px solid var(--plum)"' : ''}><span>${R.SALESPERSON_NAMES[p]} · ${changed ? `${R.formatPercent(proposed[p])} → ` : ''}${R.formatPercent(bp[p])}</span><b>${eurC(c.parts[p])}</b></div>`;
    }).join('')}</div>${bar}`;
}

function renderExpenseForm() {
  return `
    <div class="grid g2">
      <form class="card form" id="expense-form" novalidate>
        <div class="card-head"><h3>Report an expense</h3><span class="muted small">Reporter: <b>${esc(S.data.actor.short)}</b> (automatic)</span></div>
        ${roleNotice('expenses')}
        <div class="row">
          <div class="field"><label for="e-ref">Reference</label><input id="e-ref" name="reference" placeholder="E04" required autocomplete="off"></div>
          <div class="field"><label for="e-amt">Amount (€)</label><input id="e-amt" name="amount" inputmode="decimal" placeholder="250.00" required></div>
          <div class="field"><label for="e-cat">Category</label><select id="e-cat" name="category"><option>Materials</option><option>Travel</option><option>Other</option></select></div>
        </div>
        <div class="field"><label for="e-desc">Description</label><input id="e-desc" name="description" placeholder="Replacement costumes after an enthusiastic dance performance" required></div>
        <div class="field"><span class="label">Proposed allocation</span>
          <div class="seg"><label><input type="radio" name="allocation" value="A" checked>A · Relatives</label><label><input type="radio" name="allocation" value="B">B · University Friends</label><label><input type="radio" name="allocation" value="OVERHEAD">Company overhead</label></div>
          <span class="hint">Overhead is allocated automatically. A or B waits for Svetlana, but already reduces the company result.</span></div>
        <div><button class="btn" type="submit">Submit expense</button></div>
      </form>
      <div>
        <div class="card"><h3>What happens next</h3>
          <p class="small">Every saved expense <b>immediately</b> reduces the company result. Project expenses stay <b>Awaiting allocation</b> until Svetlana confirms the project or moves it; approving assigns the expense to a project without deducting it twice.</p>
          <p class="small muted">Telegram equivalent:<br><code>/expense E04 | Replacement costumes | 250 | Materials | B</code></p>
        </div>
        ${confirmation()}
      </div>
    </div>`;
}
afterRender.expense = () => {
  const f = $('#expense-form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = { reference: f.reference.value, description: f.description.value, amount: f.amount.value, category: f.category.value, allocation: f.allocation.value };
    await submitForm(f, { action: 'submitExpense', data });
  });
};

async function submitForm(f, body) {
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  try {
    const r = await act(body);
    S.lastSubmit = { tab: S.tab, message: r.message, reference: r.transaction.reference };
    toast(`${r.transaction.reference} recorded.${r.transaction.sheet_status !== 'synced' ? ' Google Sheets sync failed — retry from Records.' : ''}`, 'ok');
    await load();
    render();
  } catch (e) {
    toast(e.message, 'bad');
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- approvals

function renderApprovals() {
  const pend = pendingItems();
  const sales = pend.filter((t) => t.kind === 'sale');
  const exps = pend.filter((t) => t.kind === 'expense');
  const intro = isManager()
    ? '<p class="muted">Approve as proposed, or correct first. Original proposals are always preserved. Leaving an item here keeps it pending.</p>'
    : `<div class="notice warn">You are acting as <b>${esc(S.data.actor.short)}</b>. You can see your own pending items, and the buttons are left in place so you can watch the <b>server deny</b> the approval.</div>`;
  return `${intro}
    <h3 class="section-gap">Sales pending approval <span class="muted small">(${sales.length})</span></h3>
    ${sales.length ? sales.map(saleCard).join('') : '<div class="card empty">No sales waiting.</div>'}
    <h3 class="section-gap" style="margin-top:26px">Expenses awaiting allocation <span class="muted small">(${exps.length})</span></h3>
    ${exps.length ? exps.map(expenseCard).join('') : '<div class="card empty">No expenses waiting.</div>'}`;
}

function saleCard(t) {
  const id = esc(t.reference);
  return `<form class="card approval ${t.project === 'A' ? 'a' : 'b'}" data-sale="${id}">
    <div class="card-head"><h3>${id} · ${eur(t.amount)}</h3>${projectBadge(t.project)}</div>
    <div class="meta"><span>Customer <b>${esc(t.customer)}</b></span><span>By ${esc(shortName(t.submitted_by))} via ${t.source === 'telegram' ? 'Telegram' : 'website'}</span><span>${fmtTime(t.submitted_at)}</span></div>
    <p style="margin:0 0 12px">${esc(t.description)}</p>
    <div class="grid g2">
      <div>
        <div class="field"><span class="label">Original proposal: ${splitText(t, 'prop')} — final split:</span>
          <div class="split-inputs">${SALES.map((p) => `<div class="field"><label>${R.SALESPERSON_NAMES[p]} %</label><input name="${p}" inputmode="decimal" value="${R.toBp(t[`prop_${p}`]) / 100}" data-orig="${R.toBp(t[`prop_${p}`]) / 100}"></div>`).join('')}</div>
        </div>
        <p class="small muted" style="margin:8px 0 0">Notification will go to ${recipientPreview(t)}.</p>
      </div>
      <div data-preview></div>
    </div>
    <div class="actions"><button class="btn gold" type="submit" data-approve-label>Approve proposed split</button><button class="btn ghost" type="button" data-reset>Reset to proposal</button><span class="muted small">or leave pending</span></div>
  </form>`;
}

function expenseCard(t) {
  const id = esc(t.reference);
  return `<form class="card approval" data-expense="${id}">
    <div class="card-head"><h3>${id} · ${eur(t.amount)}</h3><span class="badge info">${esc(t.category)}</span></div>
    <div class="meta"><span>By ${esc(shortName(t.submitted_by))} via ${t.source === 'telegram' ? 'Telegram' : 'website'}</span><span>${fmtTime(t.submitted_at)}</span><span>Proposed: ${allocBadge(t.proposed_allocation)}</span></div>
    <p style="margin:0 0 12px">${esc(t.description)}</p>
    <div class="field"><span class="label">Final allocation</span>
      <div class="seg">${['A', 'B', 'OVERHEAD'].map((a) => `<label><input type="radio" name="allocation" value="${a}" ${a === t.proposed_allocation ? 'checked' : ''}>${a === 'OVERHEAD' ? 'Company overhead' : `${a} · ${R.PROJECTS[a]}`}</label>`).join('')}</div></div>
    <p class="small muted" style="margin:8px 0 0">Notification will go to ${recipientPreview(t)}.</p>
    <div class="actions"><button class="btn gold" type="submit" data-approve-label>Confirm allocation</button><span class="muted small">or leave awaiting allocation</span></div>
  </form>`;
}

afterRender.approvals = () => {
  $$('form[data-sale]').forEach((f) => {
    const t = txs().find((x) => x.reference === f.dataset.sale);
    const proposed = { richard: R.toBp(t.prop_richard), anastasia: R.toBp(t.prop_anastasia), jeanclaude: R.toBp(t.prop_jeanclaude) };
    const update = () => {
      const split = readSplit(f);
      $('[data-preview]', f).innerHTML = splitPreview(t.amount, split, proposed);
      let changed = false;
      try { changed = !R.splitsEqual(R.normaliseSplit(split), proposed); } catch { changed = true; }
      $('[data-approve-label]', f).textContent = changed ? 'Approve with corrected split' : 'Approve proposed split';
    };
    f.addEventListener('input', update);
    $('[data-reset]', f).addEventListener('click', () => { SALES.forEach((p) => { f[p].value = f[p].dataset.orig; }); update(); });
    update();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const split = readSplit(f);
      let changed = true;
      try { changed = !R.splitsEqual(R.normaliseSplit(split), proposed); } catch { /* server will explain */ }
      await decide(f, { action: 'approveSale', reference: t.reference, split: changed ? split : null });
    });
  });
  $$('form[data-expense]').forEach((f) => {
    const t = txs().find((x) => x.reference === f.dataset.expense);
    const update = () => {
      const a = f.allocation.value;
      $('[data-approve-label]', f).textContent = a === t.proposed_allocation ? `Confirm allocation to ${a === 'OVERHEAD' ? 'overhead' : a}` : `Move to ${a === 'OVERHEAD' ? 'overhead' : a} and approve`;
    };
    f.addEventListener('change', update);
    update();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      await decide(f, { action: 'allocateExpense', reference: t.reference, allocation: f.allocation.value });
    });
  });
};

async function decide(f, body) {
  $$('button', f).forEach((b) => { b.disabled = true; });
  try {
    const r = await act(body);
    const t = r.transaction;
    const note = t.notify_status === 'sent' ? 'Telegram notification sent.'
      : t.notify_status === 'no_recipient' ? 'No Telegram recipient linked — shown on the record.'
      : t.notify_status === 'failed' ? 'Telegram delivery FAILED — retry from Records.' : '';
    toast(r.alreadyDone ? r.message : `${t.reference} decided. ${note}${t.sheet_status !== 'synced' ? ' Sheets sync failed — retry available.' : ''}`, r.alreadyDone ? '' : 'ok');
    await load();
    render();
  } catch (e) {
    toast(e.message, 'bad');
    $$('button', f).forEach((b) => { b.disabled = false; });
  }
}

// ---------------------------------------------------------------- manager setup

function renderSetup() {
  const d = S.data;
  const users = d.telegramUsers || [];
  const userLabel = (u) => `${u.first_name || 'Unknown'}${u.username ? ` @${u.username}` : ''} · ${u.user_id}`;
  const failures = txs().filter((t) => t.sheet_status !== 'synced');
  return `
    <div class="card">
      <div class="card-head"><h3>Telegram links</h3><span class="muted small">A Telegram user ID belongs to at most one employee. Nobody can pick their own role in the bot.</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Employee</th><th>Role</th><th>Linked Telegram user</th><th>Link to…</th><th></th></tr></thead>
        <tbody>${d.employees.map((e) => `<tr>
          <td><b>${esc(e.short)}</b><div class="small muted">${esc(e.name)}</div></td>
          <td class="small">${esc(e.title)}</td>
          <td>${e.telegram_user_id ? `<span class="badge ok">${esc(e.telegram_user_id)}</span>` : '<span class="muted small">not linked</span>'}</td>
          <td><form class="chips" data-link="${e.id}">
            <select name="uid" aria-label="Telegram user for ${esc(e.short)}" style="padding:6px 8px;border:1px solid var(--line);border-radius:8px;max-width:230px">
              <option value="">Choose someone who pressed /start…</option>
              ${users.map((u) => `<option value="${esc(u.user_id)}" ${String(u.user_id) === String(e.telegram_user_id) ? 'selected' : ''}>${esc(userLabel(u))}</option>`).join('')}
            </select>
            <input name="manual" placeholder="or type an ID" inputmode="numeric" style="width:130px;padding:6px 8px;border:1px solid var(--line);border-radius:8px">
            <button class="btn sm" type="submit">Link</button>
          </form></td>
          <td>${e.telegram_user_id ? `<button class="btn danger sm" data-unlink="${e.id}">Unlink</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="small muted">Linking moves the Telegram ID away from anyone else. Transactions already submitted through the bot keep their original chat as notification destination.</p>
    </div>

    <div class="grid g2 section-gap">
      <div class="card">
        <div class="card-head"><h3>People who started the bot</h3><button class="btn ghost sm" data-refresh>↻ Refresh</button></div>
        ${users.length ? `<table><thead><tr><th>Name</th><th>User ID</th><th>Last seen</th></tr></thead><tbody>${users.map((u) => `<tr><td>${esc(u.first_name || '—')}${u.username ? ` <span class="muted">@${esc(u.username)}</span>` : ''}</td><td class="mono">${esc(u.user_id)}</td><td class="small">${fmtTime(u.last_seen)}</td></tr>`).join('')}</tbody></table>`
          : `<div class="empty">Nobody yet. Open ${S.config?.botUsername ? `<a href="https://t.me/${esc(S.config.botUsername)}" target="_blank" rel="noopener">@${esc(S.config.botUsername)}</a>` : 'the bot'} and press <b>Start</b>.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h3>Failure drills</h3><span class="badge info">fault injection</span></div>
        <p class="small muted" style="margin-top:0">Switch these on to rehearse the brief’s “interrupted update” checks on the live system. Financial decisions still save; only delivery is affected.</p>
        <div class="pill-toggle"><div><b>Simulate Google Sheets outage</b><div class="small muted">New saves show “Sync failed” with a Retry button.</div></div>
          <label class="switch"><input type="checkbox" data-fault="simulate_sheets_outage" ${d.settings?.simulate_sheets_outage ? 'checked' : ''}><span></span></label></div>
        <div class="pill-toggle"><div><b>Simulate Telegram failure</b><div class="small muted">Decisions stay approved; notification shows “Not delivered”, never “Sent”.</div></div>
          <label class="switch"><input type="checkbox" data-fault="simulate_telegram_failure" ${d.settings?.simulate_telegram_failure ? 'checked' : ''}><span></span></label></div>
        ${failures.length ? `<div class="notice warn section-gap">${failures.length} record(s) not in Google Sheets. <button class="btn sm" data-retry-all>Retry all</button></div>` : '<div class="notice ok section-gap">All records are synchronised with Google Sheets.</div>'}
      </div>
    </div>`;
}
afterRender.setup = () => {
  $$('form[data-link]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const uid = f.manual.value.trim() || f.uid.value;
    if (!uid) return toast('Choose a Telegram user or type an ID.', 'bad');
    try { const r = await act({ action: 'linkTelegram', employeeId: f.dataset.link, telegramUserId: uid }); toast(r.message, 'ok'); await load(); render(); } catch (err) { toast(err.message, 'bad'); }
  }));
};

// ---------------------------------------------------------------- ledger

const ACTION_LABEL = {
  'sale.submitted': 'Sale submitted', 'expense.submitted': 'Expense submitted',
  'sale.approved': 'Sale approved', 'expense.allocated': 'Expense allocated',
  'sale.refused': 'Sale refused', 'expense.refused': 'Expense refused', denied: 'Permission denied',
  'sale.approve_ignored': 'Repeat approval ignored', 'expense.allocate_ignored': 'Repeat allocation ignored',
  'telegram.sent': 'Telegram delivered', 'telegram.failed': 'Telegram failed', 'telegram.no_recipient': 'No Telegram recipient',
  'telegram.retry': 'Telegram retry', 'telegram.linked': 'Telegram linked', 'telegram.unlinked': 'Telegram unlinked',
  'sheets.failed': 'Sheets sync failed', 'sheets.retry_ok': 'Sheets retry OK', 'fault.switch': 'Fault switch',
};
const actionTone = (a) => (a === 'denied' || a.endsWith('refused') || a.endsWith('failed') || a === 'telegram.no_recipient' ? 'bad' : a.endsWith('ignored') || a.startsWith('fault') ? 'warn' : a.endsWith('approved') || a.endsWith('allocated') || a.endsWith('sent') || a.endsWith('ok') ? 'ok' : 'info');

function renderLedger() {
  if (!S.ledger) { loadLedger(); return '<div class="card empty">Reading the ledger…</div>'; }
  if (S.ledger.error) return `<div class="card notice bad">${esc(S.ledger.error)}</div>`;
  const v = S.ledger.verification;
  const details = (d) => { try { const o = JSON.parse(d); return Object.entries(o).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' · '); } catch { return d; } };
  return `
    <div class="card">
      <div class="verify ${v.ok ? 'ok' : 'bad'}">
        <div class="icon">${v.ok ? '⛓️' : '⚠️'}</div>
        <div style="flex:1"><b>${v.ok ? `Chain intact — ${v.count} entries verified` : `Tampering detected at entry #${v.brokenAt}`}</b>
          <div class="small">${v.ok ? `Head hash <span class="mono">${esc((v.head || '').slice(0, 24))}…</span>. Every entry’s SHA-256 hash covers its content and the previous hash.` : esc(v.reason)}</div></div>
        <button class="btn ghost sm" data-verify>Verify again</button>
      </div>
      <p class="small muted">Every submission, decision, refusal, denied attempt, link change and delivery result is appended here. Try it: edit or delete any row of <code>audit_log</code> in Supabase, then press <b>Verify again</b> — the break is pinpointed to the exact entry.</p>
    </div>
    <div class="card section-gap"><div class="chain">${S.ledger.entries.map((e) => `
      <div class="block ${!v.ok && Number(e.seq) >= v.brokenAt ? 'broken' : ''}">
        <div class="seq">#${e.seq}</div>
        <div class="body">
          <div class="top"><span class="badge ${actionTone(e.action)}">${esc(ACTION_LABEL[e.action] || e.action)}</span>${e.reference ? `<b>${esc(e.reference)}</b>` : ''}<span class="muted">by ${esc(e.actor === 'system' ? 'system' : shortName(e.actor) || '—')}</span><span class="muted small">${new Date(e.at).toLocaleString('en-GB')}</span></div>
          ${e.details ? `<div class="small">${esc(details(e.details))}</div>` : ''}
          <div class="hashes">prev ${esc(e.prev_hash.slice(0, 16))}… → hash ${esc(e.hash.slice(0, 16))}…</div>
        </div>
      </div>`).join('') || '<div class="empty">Ledger is empty.</div>'}</div></div>`;
}
async function loadLedger() {
  try { S.ledger = await api('/api/ledger'); } catch (e) { S.ledger = { error: e.message }; }
  if (S.tab === 'ledger') {
    try { render(); } catch (e) { console.error(e); S.ledger = { error: `Could not display the ledger: ${e.message}` }; render(); }
  }
}

// ---------------------------------------------------------------- acceptance test

const EXPECTED_T2 = {
  'Project A result': [(r) => r.projects.A.result, 205000], 'Project B result': [(r) => r.projects.B.result, 218000],
  'Approved income': [(r) => r.company.income, 530000], 'Commission expense': [(r) => r.company.commission, 53000],
  'Allocated project expenses': [(r) => r.company.allocatedExpenses, 54000], 'Company overhead': [(r) => r.company.overhead, 16000],
  'Awaiting allocation': [(r) => r.company.awaiting, 14000], 'Company result': [(r) => r.company.result, 393000],
  'Richard commission': [(r) => r.commissionBy.richard, 14000], 'Anastasia commission': [(r) => r.commissionBy.anastasia, 17500],
  'Jean-Claude commission': [(r) => r.commissionBy.jeanclaude, 21500],
};

function renderTest() {
  const st = S.selftest;
  let body = '<p class="muted">Press run to replay the whole brief — Test 1, Test 2, the six rule-enforcement attempts, the interrupted-sync drills and a tampering attempt — through the real processing layer on an isolated in-memory copy. Live data is never touched.</p>';
  if (st?.loading) body = '<div class="empty">Running…</div>';
  else if (st?.error) body = `<div class="notice bad">${esc(st.error)}</div>`;
  else if (st) {
    const sections = [...new Set(st.checks.map((c) => c.section))];
    body = `<div class="test-summary"><div class="score ${st.failed ? 'bad' : 'ok'}">${st.passed}/${st.total}</div>
      <div><b>${st.failed ? `${st.failed} check(s) failed` : 'All checks passed'}</b><div class="small muted">in ${st.ms} ms on the server · same code as the live system</div></div></div>
      <div class="section-gap">${sections.map((s) => {
        const cs = st.checks.filter((c) => c.section === s);
        const bad = cs.filter((c) => !c.ok).length;
        return `<details class="section" ${bad ? 'open' : ''}><summary><span>${esc(s)}</span><span class="badge ${bad ? 'bad' : 'ok'}">${cs.length - bad}/${cs.length}</span></summary>
          <ul class="checks">${cs.map((c) => `<li><span class="${c.ok ? 'pass' : 'fail'}">${c.ok ? '✓' : '✗'}</span><span>${esc(c.name)}</span>${c.ok ? '' : `<span class="why">expected ${esc(JSON.stringify(c.expected))} · got ${esc(JSON.stringify(c.actual))}</span>`}</li>`).join('')}</ul></details>`;
      }).join('')}</div>`;
  }
  const live = isManager() ? liveComparison() : '';
  return `
    <div class="card">
      <div class="card-head"><div><h3>The homework brief, as executable code</h3><span class="muted small">lib/scenario.js · also runs locally with <code>npm test</code></span></div><button class="btn gold" data-run-test>${st && !st.loading ? 'Run again' : 'Run acceptance test'}</button></div>
      ${body}
    </div>
    ${live}
    <div class="card section-gap">
      <div class="card-head"><div><h3>Permission probe</h3><span class="muted small">Sends real requests as <b>${esc(S.data.actor.short)}</b>. The server must refuse them and the control totals must not move.</span></div></div>
      <div class="chips">${probes().map((p, i) => `<button class="btn ghost sm" data-probe="${i}" ${p.disabled ? `disabled title="${esc(p.disabled)}"` : ''}>${esc(p.label)}</button>`).join('')}</div>
      ${S.probe.length ? `<table class="section-gap"><thead><tr><th>Attempt</th><th>Server answer</th><th>Totals</th></tr></thead><tbody>${S.probe.map((p) => `<tr><td>${esc(p.label)}<div class="small muted">as ${esc(p.as)}</div></td><td>${p.ok ? '<span class="badge warn">accepted</span>' : '<span class="badge ok">refused</span>'} <span class="small">${esc(p.message)}</span></td><td>${p.same ? '<span class="badge ok">unchanged</span>' : '<span class="badge bad">changed</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
    </div>`;
}

function liveComparison() {
  const r = S.data.results;
  const rows = Object.entries(EXPECTED_T2).map(([k, [f, exp]]) => ({ k, live: f(r), exp }));
  const all = rows.every((x) => x.live === x.exp);
  return `<div class="card section-gap">
    <div class="card-head"><div><h3>Live data vs the brief’s cumulative table</h3><span class="muted small">After both tests the live figures should match. If the instructor has entered extra transactions, differences are expected and correct.</span></div>${all ? '<span class="badge ok">✓ matches the brief exactly</span>' : '<span class="badge info">differs from the brief</span>'}</div>
    <div class="table-wrap"><table><thead><tr><th>Measure</th><th class="num">Brief (after Test 2)</th><th class="num">Live</th><th></th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td>${esc(x.k)}</td><td class="num">${eurC(x.exp)}</td><td class="num">${eurC(x.live)}</td><td>${x.live === x.exp ? '<span class="pass" style="color:var(--ok)">✓</span>' : `<span class="small muted">Δ ${eurC(x.live - x.exp)}</span>`}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function probes() {
  const role = S.data.actor.role;
  const all = txs();
  const pendingSale = all.find((t) => t.kind === 'sale' && t.status === 'pending');
  const pendingExp = all.find((t) => t.kind === 'expense' && t.status === 'awaiting_allocation');
  const approvedSale = all.find((t) => t.kind === 'sale' && t.status === 'approved');
  const existing = all[0];
  const allowedMsg = 'Your current role is allowed to do this, so the probe is disabled to avoid creating a real record. Switch role to test it.';
  return [
    { label: 'Approve a sale', disabled: role === 'manager' ? allowedMsg : null, body: { action: 'approveSale', reference: pendingSale?.reference || approvedSale?.reference || 'S05' } },
    { label: 'Allocate an expense', disabled: role === 'manager' ? allowedMsg : null, body: { action: 'allocateExpense', reference: pendingExp?.reference || 'E07', allocation: 'B' } },
    { label: 'Submit a sale', disabled: role === 'sales' ? allowedMsg : null, body: { action: 'submitSale', data: { reference: 'PROBE-S1', customer: 'Probe', project: 'A', description: 'Permission probe', amount: '100', split: { richard: 100, anastasia: 0, jeanclaude: 0 } } } },
    { label: 'Submit an expense', disabled: role === 'expenses' ? allowedMsg : null, body: { action: 'submitExpense', data: { reference: 'PROBE-E1', description: 'Permission probe', amount: '10', category: 'Other', allocation: 'A' } } },
    { label: 'Change a Telegram link', disabled: role === 'manager' ? allowedMsg : null, body: { action: 'linkTelegram', employeeId: 'svetlana', telegramUserId: '123456789' } },
    { label: 'Split 60 / 30 / 20', body: { action: 'submitSale', data: { reference: 'PROBE-S2', customer: 'Probe', project: 'A', description: 'Bad split', amount: '100', split: { richard: 60, anastasia: 30, jeanclaude: 20 } } } },
    { label: 'Expense with €0', body: { action: 'submitExpense', data: { reference: 'PROBE-E2', description: 'Zero', amount: '0', category: 'Other', allocation: 'A' } } },
    { label: 'Expense with no amount', body: { action: 'submitExpense', data: { reference: 'PROBE-E3', description: 'Missing', amount: '', category: 'Other', allocation: 'A' } } },
    { label: `Duplicate reference ${existing?.reference || ''}`, disabled: existing ? null : 'No existing record yet.', body: { action: existing?.kind === 'sale' ? 'submitSale' : 'submitExpense', data: existing?.kind === 'sale' ? { reference: existing?.reference, customer: 'Dup', project: 'A', description: 'Dup', amount: '1', split: { richard: 100, anastasia: 0, jeanclaude: 0 } } : { reference: existing?.reference, description: 'Dup', amount: '1', category: 'Other', allocation: 'A' } } },
    { label: `Approve ${approvedSale?.reference || 'an approved sale'} again`, disabled: approvedSale ? null : 'No approved sale yet.', body: { action: 'approveSale', reference: approvedSale?.reference } },
  ];
}

async function runProbe(i) {
  const p = probes()[i];
  const snapshot = async () => { const s = await api('/api/state', { role: 'svetlana' }); return JSON.stringify([s.results, s.transactions.length]); };
  const before = await snapshot();
  let ok = false; let message = '';
  try { const r = await act(p.body); ok = !r.alreadyDone; message = r.message || 'accepted'; } catch (e) { message = e.message; }
  const after = await snapshot();
  S.probe.unshift({ label: p.label, as: S.data.actor.short, ok, message, same: before === after });
  await load();
  render();
}

// ---------------------------------------------------------------- guide

function renderGuide() {
  const c = S.config || {};
  const bot = c.botUsername ? `<a href="https://t.me/${esc(c.botUsername)}" target="_blank" rel="noopener">@${esc(c.botUsername)}</a>` : 'the Telegram bot';
  return `
    <div class="grid g2">
      <div class="card">
        <h3>Where to do what</h3>
        <ol class="steps section-gap">
          <li><div><b>Pick a demonstration role</b> at the top right. Svetlana (manager) sees everything; salespeople and Kevin see only their own records. The server enforces each role’s permissions.</div></li>
          <li><div><b>Enter transactions</b> in <a href="#sale" data-go="sale">New sale</a> (as Richard, Anastasia or Jean-Claude) or <a href="#expense" data-go="expense">New expense</a> (as Kevin) — or through ${bot}.</div></li>
          <li><div><b>Approve decisions</b> as Svetlana in <a href="#approvals" data-go="approvals">Approvals</a>: confirm or correct commission splits and expense allocations. Leaving an item there keeps it pending.</div></li>
          <li><div><b>Read results</b> on the <a href="#dashboard" data-go="dashboard">Dashboard</a>. Records mirror to Google Sheets automatically; failures show a Retry button.</div></li>
          <li><div><b>Link Telegram accounts</b> in <a href="#setup" data-go="setup">Manager setup</a> after the person sends <code>/start</code> to the bot.</div></li>
          <li><div><b>Verify</b> in <a href="#test" data-go="test">Acceptance test</a> (replays the brief) and <a href="#ledger" data-go="ledger">Audit ledger</a> (tamper-evident history).</div></li>
        </ol>
      </div>
      <div class="card">
        <h3>Telegram commands</h3>
        <p class="small">Start the bot in a private chat first. Your Telegram user ID must be linked to an employee by Svetlana.</p>
        <div class="kbd-block">/start    show my ID and link status
/help     formats for my role
/mine     my latest submissions

/sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000 | 50/30/20

/expense E01 | Rented suit and fake pearl necklace for the relatives | 120 | Materials | A</div>
        <p class="small muted">Project: A or B · Allocation: A, B or Overhead · Split order: Richard / Anastasia / Jean-Claude.</p>
      </div>
    </div>
    <div class="card section-gap">
      <h3>Architecture</h3>
      ${architectureSvg()}
      <div class="grid g3 section-gap small">
        <div><b>One processing layer.</b> The Telegram webhook and the website both call <code>lib/service.js</code>, so validation, permissions and commission maths cannot drift apart.</div>
        <div><b>Idempotent decisions.</b> Approvals are compare-and-set updates on “still pending” rows: a double click, a retry or two managers at once can never double-count.</div>
        <div><b>Delivery ≠ decision.</b> Sheets sync and Telegram delivery are tracked separately from the financial decision, with honest statuses and retries that reuse the same row.</div>
      </div>
    </div>
    <div class="card section-gap small">
      <b>Links for the instructor:</b>
      ${c.botUsername ? `Telegram bot <a href="https://t.me/${esc(c.botUsername)}" target="_blank" rel="noopener">t.me/${esc(c.botUsername)}</a> · ` : ''}
      ${c.sheetUrl ? `<a href="${esc(c.sheetUrl)}" target="_blank" rel="noopener">Google Sheet</a> · ` : ''}
      ${c.githubUrl ? `<a href="${esc(c.githubUrl)}" target="_blank" rel="noopener">GitHub repository</a>` : ''}
    </div>`;
}

function architectureSvg() {
  const box = (x, y, w, h, title, sub, fill, stroke) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}"/><text x="${x + w / 2}" y="${y + h / 2 - 3}" text-anchor="middle" font-weight="700" font-size="14">${title}</text><text x="${x + w / 2}" y="${y + h / 2 + 15}" text-anchor="middle" font-size="11.5" fill="#7b6f69">${sub}</text>`;
  const arrow = (x1, y1, x2, y2, label = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#b08d57" stroke-width="2" marker-end="url(#ah)"/>${label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-size="11" fill="#7b6f69" dy="-6">${label}</text>` : ''}`;
  return `<div class="table-wrap"><svg viewBox="0 0 900 250" style="width:100%;min-width:640px;height:auto;font-family:Inter,sans-serif">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#b08d57"/></marker></defs>
    ${box(10, 30, 170, 64, 'Telegram bot', '/sale · /expense · /start', '#e8eff5', '#3f5e7a')}
    ${box(10, 150, 170, 64, 'Website (Vercel)', 'role selector · forms', '#f9ebe4', '#c0603f')}
    ${box(290, 80, 220, 84, 'Processing layer', 'permissions · rules · CAS', '#f4ecdf', '#b08d57')}
    ${box(630, 10, 250, 60, 'Supabase', 'source of truth + audit ledger', '#fff', '#2f7d57')}
    ${box(630, 95, 250, 60, 'Google Sheets', 'Sales + Expenses mirror (upsert)', '#fff', '#2f7d57')}
    ${box(630, 180, 250, 60, 'Telegram notifications', 'to the original chat', '#fff', '#2f7d57')}
    ${arrow(180, 62, 288, 108, 'webhook')}
    ${arrow(180, 182, 288, 140, '/api/action')}
    ${arrow(510, 105, 628, 42, 'save first')}
    ${arrow(510, 122, 628, 125, 'then sync')}
    ${arrow(510, 140, 628, 208, 'then notify')}
  </svg></div>`;
}

// ---------------------------------------------------------------- events

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-tab],[data-go],[data-filter],[data-toggle],[data-refresh],[data-retry-sheet],[data-retry-notify],[data-unlink],[data-verify],[data-run-test],[data-probe],[data-retry-all]');
  if (!el) return;
  if (el.dataset.tab) return go(el.dataset.tab);
  if (el.dataset.go) { e.preventDefault(); if (el.dataset.filter) S.filter = el.dataset.filter; return go(el.dataset.go); }
  if (el.dataset.filter) { S.filter = el.dataset.filter; return render(); }
  if (el.dataset.toggle && !e.target.closest('button')) {
    const r = el.dataset.toggle;
    if (S.open.has(r)) S.open.delete(r); else S.open.add(r);
    return render();
  }
  try {
    if (el.dataset.refresh !== undefined) { await load(); render(); toast('Refreshed.'); }
    if (el.dataset.retrySheet) { el.disabled = true; const r = await act({ action: 'retrySheet', reference: el.dataset.retrySheet }); toast(r.message, r.transaction.sheet_status === 'synced' ? 'ok' : 'bad'); await load(); render(); }
    if (el.dataset.retryNotify) { el.disabled = true; const r = await act({ action: 'retryNotify', reference: el.dataset.retryNotify }); toast(r.message, r.transaction.notify_status === 'sent' ? 'ok' : 'bad'); await load(); render(); }
    if (el.dataset.unlink) { const r = await act({ action: 'linkTelegram', employeeId: el.dataset.unlink, telegramUserId: null }); toast(r.message, 'ok'); await load(); render(); }
    if (el.dataset.verify !== undefined) { S.ledger = null; render(); }
    if (el.dataset.runTest !== undefined) {
      S.selftest = { loading: true }; render();
      try { S.selftest = await api('/api/selftest'); } catch (err) { S.selftest = { error: err.message }; }
      render();
    }
    if (el.dataset.probe !== undefined) { el.disabled = true; await runProbe(Number(el.dataset.probe)); }
    if (el.dataset.retryAll !== undefined) {
      el.disabled = true;
      const failed = txs().filter((t) => t.sheet_status !== 'synced');
      for (const t of failed) await act({ action: 'retrySheet', reference: t.reference });
      await load(); render(); toast(`Retried ${failed.length} record(s).`, 'ok');
    }
  } catch (err) {
    toast(err.message, 'bad');
    await load().catch(() => {}); render();
  }
});

document.addEventListener('change', async (e) => {
  const sw = e.target.closest('[data-fault]');
  if (!sw) return;
  try { const r = await act({ action: 'setFault', key: sw.dataset.fault, value: sw.checked }); toast(r.message, sw.checked ? 'bad' : 'ok'); await load(); render(); }
  catch (err) { toast(err.message, 'bad'); sw.checked = !sw.checked; }
});

// ---------------------------------------------------------------- boot

async function boot() {
  const sel = $('#role');
  sel.innerHTML = EMPLOYEE_OPTIONS.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');
  if (!EMPLOYEE_OPTIONS.some(([id]) => id === S.role)) S.role = 'svetlana';
  sel.value = S.role;
  $('#role-hint').textContent = ROLE_HINT[S.role];
  sel.addEventListener('change', async () => {
    S.role = sel.value;
    store.set('fi-role', S.role);
    $('#role-hint').textContent = ROLE_HINT[S.role];
    S.lastSubmit = null; S.ledger = null; S.open.clear();
    await load(); render();
    toast(`Now acting as ${S.data.actor.short}.`);
  });

  S.config = await api('/api/config').catch(() => ({}));
  $('#student-name').textContent = S.config.studentName || 'Student';
  const links = [];
  links.push(S.config.botUsername ? `<a href="https://t.me/${esc(S.config.botUsername)}" target="_blank" rel="noopener">✈ Telegram bot</a>` : '<span>Telegram bot link not configured</span>');
  links.push(S.config.sheetUrl ? `<a href="${esc(S.config.sheetUrl)}" target="_blank" rel="noopener">▦ Google Sheet</a>` : '<span>Sheet link not configured</span>');
  links.push(S.config.githubUrl ? `<a href="${esc(S.config.githubUrl)}" target="_blank" rel="noopener">⌥ GitHub</a>` : '<span>GitHub link not configured</span>');
  $('#links').innerHTML = links.join('');
  if (S.config.mode?.demo) {
    const b = $('#mode-banner');
    b.hidden = false;
    b.innerHTML = `<div class="banner"><b>Demo mode:</b> storage is ${esc(S.config.mode.storage)}, sheet is ${esc(S.config.mode.sheets)}, bot is ${esc(S.config.mode.telegram)}. Configure the environment variables from the README to connect Supabase, Google Sheets and Telegram.</div>`;
  }

  const hash = location.hash.slice(1);
  S.tab = TABS.some((t) => t.id === hash) ? hash : store.get('fi-tab', 'dashboard');
  await load();
  render();
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (h !== S.tab && TABS.some((t) => t.id === h)) go(h);
  });

  // Light polling so Telegram submissions appear without a manual refresh (skipped while typing in forms).
  setInterval(async () => {
    if (document.hidden || !['dashboard', 'records'].includes(S.tab)) return;
    const before = JSON.stringify(S.data?.transactions);
    await load().catch(() => {});
    if (JSON.stringify(S.data?.transactions) !== before) render();
  }, 15000);
}

boot();
