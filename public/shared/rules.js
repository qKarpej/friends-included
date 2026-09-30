// Pure business rules for Friends Included Ltd — shared by the server AND the browser.
// No I/O lives here: every number shown on the website, written to Google Sheets
// or sent through Telegram is produced by these functions.

export const SALESPEOPLE = ['richard', 'anastasia', 'jeanclaude'];
export const SALESPERSON_NAMES = { richard: 'Richard', anastasia: 'Anastasia', jeanclaude: 'Jean-Claude' };
export const PROJECTS = { A: 'Respectable Relatives', B: 'Drunk University Friends' };
export const ALLOCATIONS = { A: 'Respectable Relatives', B: 'Drunk University Friends', OVERHEAD: 'Company overhead' };
export const CATEGORIES = ['Materials', 'Travel', 'Other'];
export const COMMISSION_RATE_BP = 1000; // 10.00 % expressed in basis points

export class RuleError extends Error {
  constructor(message, code = 'invalid', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------- money ----------

/** Parse a user-typed euro amount into integer cents. Accepts "1000", "1,000", "€1 000.50", "80,5". */
export function parseAmountToCents(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/€|eur(o|os)?/gi, '').replace(/\s+/g, '');
  if (s === '') return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return s.startsWith('-') ? -cents : cents;
}

export const toCents = (euros) => Math.round(Number(euros || 0) * 100);
export const fromCents = (cents) => Math.round(cents) / 100;

export function formatEuro(value, { cents = false } = {}) {
  const c = cents ? value : toCents(value);
  const sign = c < 0 ? '−' : '';
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}€${whole}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------- percentages ----------

/** Percent (e.g. 33.33) -> basis points (3333). Returns NaN when more than 2 decimals. */
export function percentToBp(value) {
  if (value === null || value === undefined || String(value).trim() === '') return NaN;
  const s = String(value).trim().replace('%', '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export const formatPercent = (bp) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** Parse "50/30/20", "50 30 20" or "50%, 30%, 20%" into { richard, anastasia, jeanclaude } basis points. */
export function parseSplitText(text) {
  const parts = String(text || '').split(/[\/\s,;|]+/).filter(Boolean);
  if (parts.length !== 3) throw new RuleError('Commission split needs three shares for Richard / Anastasia / Jean-Claude, e.g. 50/30/20.');
  return normaliseSplit({ richard: parts[0], anastasia: parts[1], jeanclaude: parts[2] });
}

/** Validate a split given as percentages and return basis points. */
export function normaliseSplit(split) {
  if (!split || typeof split !== 'object') throw new RuleError('A commission split is required.');
  const out = {};
  for (const p of SALESPEOPLE) {
    const bp = percentToBp(split[p]);
    if (Number.isNaN(bp)) throw new RuleError(`${SALESPERSON_NAMES[p]}'s share must be a number from 0 to 100 (maximum two decimals).`);
    if (bp < 0 || bp > 10000) throw new RuleError(`${SALESPERSON_NAMES[p]}'s share must be between 0% and 100%.`);
    out[p] = bp;
  }
  const total = out.richard + out.anastasia + out.jeanclaude;
  if (total !== 10000) {
    throw new RuleError(`Commission shares must total exactly 100%. These total ${formatPercent(total)}.`, 'split_total');
  }
  return out;
}

// ---------- commission ----------

/**
 * Commission pool = 10 % of the sale, rounded to cents.
 * Each share is floored to the cent; the leftover cents go to the largest share
 * (ties: Richard, then Anastasia, then Jean-Claude), so the parts always add up to the pool.
 */
export function computeCommission(amountCents, splitBp) {
  const pool = Math.round((amountCents * COMMISSION_RATE_BP) / 10000);
  const parts = {};
  let assigned = 0;
  for (const p of SALESPEOPLE) {
    parts[p] = Math.floor((pool * splitBp[p]) / 10000);
    assigned += parts[p];
  }
  const leader = SALESPEOPLE.reduce((best, p) => (splitBp[p] > splitBp[best] ? p : best), SALESPEOPLE[0]);
  parts[leader] += pool - assigned;
  return { pool, parts, roundingTo: pool - assigned ? leader : null, roundingCents: pool - assigned };
}

export const splitsEqual = (a, b) => SALESPEOPLE.every((p) => Number(a?.[p]) === Number(b?.[p]));

// ---------- validation ----------

export function normaliseReference(ref) {
  const r = String(ref ?? '').trim().toUpperCase();
  if (!r) throw new RuleError('A unique reference is required (for example S01 or E01).');
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(r)) throw new RuleError('References may contain letters, digits, "-" or "_" (maximum 20 characters).');
  return r;
}

function requireText(value, label, max = 500) {
  const v = String(value ?? '').trim();
  if (!v) throw new RuleError(`${label} is required.`);
  if (v.length > max) throw new RuleError(`${label} is too long (maximum ${max} characters).`);
  return v;
}

function requireAmount(value) {
  const cents = parseAmountToCents(value);
  if (cents === null) throw new RuleError('Amount is required.');
  if (Number.isNaN(cents)) throw new RuleError('Amount must be a number in euros with at most two decimals, e.g. 1000 or 80.50.');
  if (cents <= 0) throw new RuleError('Amount must be greater than zero.');
  if (cents > 100_000_000_00) throw new RuleError('Amount is unrealistically large.');
  return cents;
}

export function parseProject(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (v === 'A' || v.startsWith('RESPECT') || v === 'PROJECT A') return 'A';
  if (v === 'B' || v.startsWith('DRUNK') || v === 'PROJECT B') return 'B';
  throw new RuleError('Project must be A (Respectable Relatives) or B (Drunk University Friends).');
}

export function parseAllocation(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (['OVERHEAD', 'COMPANY', 'COMPANY OVERHEAD', 'OH', 'C'].includes(v)) return 'OVERHEAD';
  try { return parseProject(v); } catch {
    throw new RuleError('Allocation must be A, B or Company overhead.');
  }
}

export function parseCategory(value) {
  const v = String(value ?? '').trim().toLowerCase();
  const hit = CATEGORIES.find((c) => c.toLowerCase() === v);
  if (!hit) throw new RuleError('Category must be Materials, Travel or Other.');
  return hit;
}

export function validateSaleInput(input) {
  return {
    reference: normaliseReference(input.reference),
    customer: requireText(input.customer, 'Customer', 120),
    project: parseProject(input.project),
    description: requireText(input.description, 'Description'),
    amountCents: requireAmount(input.amount),
    split: normaliseSplit(input.split),
  };
}

export function validateExpenseInput(input) {
  return {
    reference: normaliseReference(input.reference),
    description: requireText(input.description, 'Description'),
    amountCents: requireAmount(input.amount),
    category: parseCategory(input.category),
    allocation: parseAllocation(input.allocation),
  };
}

// ---------- results ----------

/**
 * Project result = approved project sales − project commissions − expenses allocated to the project.
 * Company result = all approved sales − all commissions − all recorded expenses.
 * Everything is summed in integer cents.
 */
export function computeResults(transactions) {
  const blank = () => ({ income: 0, commission: 0, expenses: 0, result: 0 });
  const r = {
    projects: { A: blank(), B: blank() },
    company: { income: 0, commission: 0, allocatedExpenses: 0, overhead: 0, awaiting: 0, expenses: 0, result: 0 },
    commissionBy: { richard: 0, anastasia: 0, jeanclaude: 0 },
    pending: { salesCount: 0, salesCents: 0, expensesCount: 0, expensesCents: 0 },
  };
  for (const t of transactions) {
    const amount = toCents(t.amount);
    if (t.kind === 'sale') {
      if (t.status !== 'approved') { r.pending.salesCount++; r.pending.salesCents += amount; continue; }
      const pool = toCents(t.commission_pool);
      r.projects[t.project].income += amount;
      r.projects[t.project].commission += pool;
      r.company.income += amount;
      r.company.commission += pool;
      for (const p of SALESPEOPLE) r.commissionBy[p] += toCents(t[`comm_${p}`]);
    } else if (t.kind === 'expense') {
      r.company.expenses += amount;
      if (t.status !== 'allocated') { r.company.awaiting += amount; r.pending.expensesCount++; r.pending.expensesCents += amount; }
      else if (t.final_allocation === 'OVERHEAD') r.company.overhead += amount;
      else { r.projects[t.final_allocation].expenses += amount; r.company.allocatedExpenses += amount; }
    }
  }
  for (const k of ['A', 'B']) {
    const p = r.projects[k];
    p.result = p.income - p.commission - p.expenses;
  }
  r.company.result = r.company.income - r.company.commission - r.company.expenses;
  r.reconciliation = {
    formula: 'Project A + Project B − company overhead − awaiting allocation = company result',
    left: r.projects.A.result + r.projects.B.result - r.company.overhead - r.company.awaiting,
    right: r.company.result,
  };
  r.reconciliation.ok = r.reconciliation.left === r.reconciliation.right;
  return r;
}

// ---------- notification text ----------

export function saleDecisionMessage(t) {
  const proposed = { richard: toBp(t.prop_richard), anastasia: toBp(t.prop_anastasia), jeanclaude: toBp(t.prop_jeanclaude) };
  const approved = { richard: toBp(t.appr_richard), anastasia: toBp(t.appr_anastasia), jeanclaude: toBp(t.appr_jeanclaude) };
  const changed = !splitsEqual(proposed, approved);
  const lines = SALESPEOPLE.map((p) => {
    const pct = changed && proposed[p] !== approved[p]
      ? `${formatPercent(proposed[p])} → ${formatPercent(approved[p])}`
      : formatPercent(approved[p]);
    return `${SALESPERSON_NAMES[p]}: ${pct} (${formatEuro(t[`comm_${p}`])})`;
  });
  return [
    `✅ Sale ${t.reference} approved — ${changed ? '⚠️ commission split CHANGED by the manager' : 'proposed split confirmed'}.`,
    `Sale ${formatEuro(t.amount)}; total commission ${formatEuro(t.commission_pool)}.`,
    ...lines,
  ].join('\n');
}

export function expenseDecisionMessage(t) {
  const changed = t.proposed_allocation !== t.final_allocation;
  return changed
    ? [
        `📦 Expense ${t.reference} — ⚠️ allocation CHANGED.`,
        `${formatEuro(t.amount)}: ${t.description}`,
        `Proposed: ${ALLOCATIONS[t.proposed_allocation]}.`,
        `Approved: ${ALLOCATIONS[t.final_allocation]}.`,
      ].join('\n')
    : [
        `📦 Expense ${t.reference} — allocation confirmed.`,
        `${formatEuro(t.amount)}: ${t.description}`,
        `Final allocation: ${ALLOCATIONS[t.final_allocation]} (as proposed).`,
      ].join('\n');
}

export function submissionMessage(t) {
  if (t.kind === 'sale') {
    return [
      `📝 Sale ${t.reference} recorded.`,
      `Amount ${formatEuro(t.amount)} · Project ${t.project} (${PROJECTS[t.project]}) · Customer ${t.customer}`,
      `Proposed split R/A/J: ${formatPercent(toBp(t.prop_richard))} / ${formatPercent(toBp(t.prop_anastasia))} / ${formatPercent(toBp(t.prop_jeanclaude))}`,
      `Status: Pending approval by Svetlana.`,
    ].join('\n');
  }
  const status = t.status === 'allocated' ? 'Allocated automatically to company overhead' : 'Awaiting allocation by Svetlana';
  return [
    `📝 Expense ${t.reference} recorded.`,
    `Amount ${formatEuro(t.amount)} · ${t.category} · Proposed allocation: ${ALLOCATIONS[t.proposed_allocation]}`,
    `Status: ${status}.`,
  ].join('\n');
}

export const toBp = (pct) => (pct === null || pct === undefined ? null : Math.round(Number(pct) * 100));
export const bpToPct = (bp) => bp / 100;
