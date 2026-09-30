// Google Sheets mirror. Supabase stays the source of truth; each transaction is
// written to exactly one row, found by its reference, so approvals and retries
// update the same row instead of appending a new one.

import { createSign } from 'node:crypto';
import { ALLOCATIONS, PROJECTS, SALESPEOPLE, toBp, splitsEqual } from './rules.js';

export const SALES_HEADERS = [
  'Reference', 'Submission time', 'Salesperson', 'Customer', 'Project', 'Description', 'Amount €',
  'Proposed % Richard', 'Proposed % Anastasia', 'Proposed % Jean-Claude',
  'Approved % Richard', 'Approved % Anastasia', 'Approved % Jean-Claude',
  'Commission € Richard', 'Commission € Anastasia', 'Commission € Jean-Claude', 'Total commission €',
  'Status', 'Split changed by manager', 'Decision time', 'Entered via',
];
export const EXPENSE_HEADERS = [
  'Reference', 'Submission time', 'Reporter', 'Description', 'Category', 'Amount €',
  'Proposed allocation', 'Final allocation', 'Status', 'Allocation changed by manager', 'Decision time', 'Entered via',
];
const SALES_MONEY_COLS = [6, 13, 14, 15, 16];
const EXPENSE_MONEY_COLS = [5];

const TZ = process.env.DISPLAY_TIMEZONE || 'Europe/Riga';
export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const STATUS_LABEL = {
  pending: 'Pending approval', approved: 'Approved',
  awaiting_allocation: 'Awaiting allocation', allocated: 'Allocated',
};
const num = (x) => (x === null || x === undefined ? '' : Number(x));

export function rowFor(t, employeesById) {
  const who = employeesById[t.submitted_by]?.short || t.submitted_by;
  if (t.kind === 'sale') {
    const approved = t.status === 'approved';
    const changed = approved && !splitsEqual(
      { richard: toBp(t.prop_richard), anastasia: toBp(t.prop_anastasia), jeanclaude: toBp(t.prop_jeanclaude) },
      { richard: toBp(t.appr_richard), anastasia: toBp(t.appr_anastasia), jeanclaude: toBp(t.appr_jeanclaude) },
    );
    return {
      tab: 'Sales',
      values: [
        t.reference, formatTime(t.submitted_at), who, t.customer, `${t.project} – ${PROJECTS[t.project]}`, t.description, num(t.amount),
        ...SALESPEOPLE.map((p) => num(t[`prop_${p}`])),
        ...SALESPEOPLE.map((p) => (approved ? num(t[`appr_${p}`]) : '')),
        ...SALESPEOPLE.map((p) => (approved ? num(t[`comm_${p}`]) : 0)),
        approved ? num(t.commission_pool) : 0,
        STATUS_LABEL[t.status], approved ? (changed ? 'Yes' : 'No') : '', formatTime(t.decided_at), t.source === 'telegram' ? 'Telegram' : 'Website',
      ],
    };
  }
  const decided = t.status === 'allocated';
  const auto = decided && !t.decided_by;
  return {
    tab: 'Expenses',
    values: [
      t.reference, formatTime(t.submitted_at), who, t.description, t.category, num(t.amount),
      ALLOCATIONS[t.proposed_allocation], decided ? ALLOCATIONS[t.final_allocation] : '',
      auto ? 'Allocated automatically (overhead)' : STATUS_LABEL[t.status],
      decided && !auto ? (t.final_allocation !== t.proposed_allocation ? 'Yes' : 'No') : '',
      formatTime(t.decided_at), t.source === 'telegram' ? 'Telegram' : 'Website',
    ],
  };
}

const colLetter = (n) => { let s = ''; n += 1; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// ---------- Google implementation (service account, no SDK) ----------

export function createGoogleSheets({ clientEmail, privateKey, spreadsheetId }) {
  let token = null;
  let tokenExpiry = 0;
  let setupDone = false;
  const api = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;

  async function accessToken() {
    if (token && Date.now() < tokenExpiry - 60_000) return token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: clientEmail, scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Google auth failed: ${data.error_description || data.error || res.status}`);
    token = data.access_token;
    tokenExpiry = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function g(method, path, body) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google Sheets ${method} failed: ${data.error?.message || res.status}`);
    return data;
  }

  /** Creates the Sales/Expenses tabs, header rows, frozen bold header and 2-decimal money format once per instance. */
  async function ensureSetup() {
    if (setupDone) return;
    const meta = await g('GET', '?fields=sheets.properties');
    const byTitle = Object.fromEntries(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    const missing = ['Sales', 'Expenses'].filter((t) => byTitle[t] === undefined);
    if (missing.length) {
      const r = await g('POST', ':batchUpdate', { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) });
      r.replies.forEach((rep, i) => { byTitle[missing[i]] = rep.addSheet.properties.sheetId; });
    }
    const requests = [];
    for (const [title, headers, money] of [['Sales', SALES_HEADERS, SALES_MONEY_COLS], ['Expenses', EXPENSE_HEADERS, EXPENSE_MONEY_COLS]]) {
      const sheetId = byTitle[title];
      requests.push(
        { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, fields: 'userEnteredValue,userEnteredFormat.textFormat.bold', rows: [{ values: headers.map((h) => ({ userEnteredValue: { stringValue: h }, userEnteredFormat: { textFormat: { bold: true } } })) }] } },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        ...money.map((c) => ({ repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } })),
      );
    }
    await g('POST', ':batchUpdate', { requests });
    setupDone = true;
  }

  return {
    kind: 'google',
    async upsert({ tab, values }) {
      await ensureSetup();
      const col = await g('GET', `/values/${encodeURIComponent(`${tab}!A:A`)}`);
      const refs = (col.values || []).map((r) => r[0]);
      const idx = refs.findIndex((r, i) => i > 0 && r === values[0]);
      const last = colLetter(values.length - 1);
      if (idx > 0) {
        const range = encodeURIComponent(`${tab}!A${idx + 1}:${last}${idx + 1}`);
        await g('PUT', `/values/${range}?valueInputOption=RAW`, { values: [values] });
        return { row: idx + 1, action: 'updated' };
      }
      const range = encodeURIComponent(`${tab}!A:${last}`);
      const r = await g('POST', `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [values] });
      return { row: r.updates?.updatedRange, action: 'appended' };
    },
    async clearData() {
      await ensureSetup();
      await g('POST', '/values:batchClear', { ranges: ['Sales!A2:ZZ', 'Expenses!A2:ZZ'] });
    },
  };
}

// ---------- in-memory implementation (self-test and local demo) ----------

export function createMemorySheets() {
  const tabs = { Sales: [SALES_HEADERS], Expenses: [EXPENSE_HEADERS] };
  return {
    kind: 'memory',
    tabs,
    async upsert({ tab, values }) {
      const rows = tabs[tab];
      const idx = rows.findIndex((r, i) => i > 0 && r[0] === values[0]);
      if (idx > 0) { rows[idx] = values; return { row: idx + 1, action: 'updated' }; }
      rows.push(values);
      return { row: rows.length, action: 'appended' };
    },
    async clearData() { tabs.Sales.length = 1; tabs.Expenses.length = 1; },
  };
}
