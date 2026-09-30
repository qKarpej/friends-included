// Runs the full acceptance scenario through the REAL Supabase repository code,
// against a small in-process imitation of Supabase's PostgREST API (tables,
// eq/neq/gte filters, ordering, upserts, unique violations → 23505).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRepo } from '../lib/repo-supabase.js';
import { runScenario } from '../lib/scenario.js';
import { EMPLOYEES } from '../lib/employees.js';

function fakePostgrest() {
  const tables = {
    employees: EMPLOYEES.map((e, i) => ({ ...e, sort_order: i + 1, telegram_user_id: null, telegram_chat_id: null })),
    telegram_users: [], telegram_updates: [], transactions: [], audit_log: [], app_settings: [],
  };
  const keys = { employees: 'id', telegram_users: 'user_id', telegram_updates: 'update_id', transactions: 'reference', audit_log: 'seq', app_settings: 'key' };
  const uniques = { employees: ['telegram_user_id'], audit_log: ['hash'] };
  const conflict = () => new Response(JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' }), { status: 409 });

  return async (url, { method, headers, body }) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const rows = tables[table];
    const filters = [...u.searchParams].filter(([k]) => !['select', 'order', 'limit', 'on_conflict'].includes(k));
    const match = (r) => filters.every(([k, v]) => {
      const [op, ...rest] = v.split('.'); const val = rest.join('.');
      const cell = r[k] === null || r[k] === undefined ? null : String(r[k]);
      if (op === 'eq') return cell === val;
      if (op === 'neq') return cell !== val;
      if (op === 'gte') return Number(cell) >= Number(val);
      throw new Error(`unsupported op ${op}`);
    });
    const prefer = headers.Prefer || '';
    const data = body ? JSON.parse(body) : null;
    const ok = (out) => new Response(prefer.includes('return=minimal') ? '' : JSON.stringify(out), { status: 200 });
    if (method === 'GET') {
      let out = rows.filter(match);
      const order = u.searchParams.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      const limit = u.searchParams.get('limit');
      return ok(JSON.parse(JSON.stringify(limit ? out.slice(0, Number(limit)) : out)));
    }
    if (method === 'POST') {
      const pk = keys[table];
      const existing = rows.find((r) => String(r[pk]) === String(data[pk]));
      if (existing && prefer.includes('merge-duplicates')) { Object.assign(existing, data); return ok([existing]); }
      if (existing) return conflict();
      for (const col of uniques[table] || []) if (data[col] !== null && rows.some((r) => r[col] === data[col])) return conflict();
      rows.push({ ...data });
      return ok([data]);
    }
    if (method === 'PATCH') {
      const hits = rows.filter(match);
      for (const col of uniques[table] || []) {
        if (data[col] !== undefined && data[col] !== null && rows.some((r) => !hits.includes(r) && r[col] === data[col])) return conflict();
      }
      hits.forEach((r) => Object.assign(r, data));
      return ok(JSON.parse(JSON.stringify(hits)));
    }
    if (method === 'DELETE') {
      tables[table] = rows.filter((r) => !match(r));
      return ok([]);
    }
    throw new Error(`unsupported ${method}`);
  };
}

test('acceptance scenario through the Supabase repository', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakePostgrest();
  try {
    const repo = createSupabaseRepo({ url: 'https://example.supabase.co', serviceKey: 'test-key' });
    const r = await runScenario({ repo });
    for (const c of r.checks.filter((x) => !x.ok)) console.log(`FAIL [${c.section}] ${c.name}\n  expected ${JSON.stringify(c.expected)}\n  actual   ${JSON.stringify(c.actual)}`);
    console.log(`Supabase repo: ${r.passed}/${r.total} checks passed`);
    assert.equal(r.failed, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
