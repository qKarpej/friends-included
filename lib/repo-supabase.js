// Supabase repository (source of truth). Talks to PostgREST over HTTPS with the
// service-role key, which only ever exists in server-side Vercel environment
// variables. No npm dependencies are needed.

import { buildEntry } from './ledger.js';
import { RuleError } from './rules.js';

export function createSupabaseRepo({ url, serviceKey }) {
  // Accept the project URL with or without a trailing "/rest/v1/".
  const base = `${url.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '')}/rest/v1`;
  const headers = {
    apikey: serviceKey,
    // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys only need apikey.
    ...(serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${serviceKey}` } : {}),
    'Content-Type': 'application/json',
  };

  async function call(method, path, body, extraHeaders = {}) {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`Supabase ${method} ${path.split('?')[0]} failed: ${data?.message || res.status}`);
      err.pgCode = data?.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }
  const rep = { Prefer: 'return=representation' };
  const enc = encodeURIComponent;

  return {
    kind: 'supabase',

    async listEmployees() { return call('GET', 'employees?select=*&order=sort_order'); },
    async getEmployee(id) { return (await call('GET', `employees?id=eq.${enc(id)}&select=*`))[0] || null; },
    async getEmployeeByTelegramUser(userId) {
      return (await call('GET', `employees?telegram_user_id=eq.${enc(userId)}&select=*`))[0] || null;
    },
    async linkTelegram(employeeId, userId, chatId) {
      if (userId !== null) {
        await call('PATCH', `employees?telegram_user_id=eq.${enc(userId)}`, { telegram_user_id: null, telegram_chat_id: null });
      }
      return (await call('PATCH', `employees?id=eq.${enc(employeeId)}`, { telegram_user_id: userId, telegram_chat_id: chatId }, rep))[0];
    },

    async upsertTelegramUser(u) {
      await call('POST', 'telegram_users?on_conflict=user_id', u, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    },
    async listTelegramUsers() { return call('GET', 'telegram_users?select=*&order=last_seen.desc'); },
    async getTelegramUser(userId) { return (await call('GET', `telegram_users?user_id=eq.${enc(userId)}&select=*`))[0] || null; },

    async markUpdateProcessed(updateId) {
      try {
        await call('POST', 'telegram_updates', { update_id: updateId }, { Prefer: 'return=minimal' });
        return true;
      } catch (e) {
        if (e.pgCode === '23505') return false;
        throw e;
      }
    },

    async insertTransaction(row) {
      try {
        return (await call('POST', 'transactions', row, rep))[0];
      } catch (e) {
        if (e.pgCode === '23505') throw new RuleError(`Reference ${row.reference} already exists. Use a new, unique reference.`, 'duplicate', 409);
        throw e;
      }
    },
    async getTransaction(ref) { return (await call('GET', `transactions?reference=eq.${enc(ref)}&select=*`))[0] || null; },
    async listTransactions() { return call('GET', 'transactions?select=*&order=submitted_at.asc'); },
    async updateTransactionIf(ref, expectedStatus, patch) {
      const rows = await call('PATCH', `transactions?reference=eq.${enc(ref)}&status=eq.${enc(expectedStatus)}`, patch, rep);
      return rows[0] || null;
    },
    async updateTransaction(ref, patch) {
      return (await call('PATCH', `transactions?reference=eq.${enc(ref)}`, patch, rep))[0] || null;
    },

    async appendAudit(fields) {
      // seq is the primary key, so two concurrent writers cannot fork the chain:
      // the loser gets a unique violation and simply re-reads the head and retries.
      for (let attempt = 0; attempt < 8; attempt++) {
        const last = (await call('GET', 'audit_log?select=seq,hash&order=seq.desc&limit=1'))[0];
        const entry = buildEntry(last, fields);
        try {
          await call('POST', 'audit_log', entry, { Prefer: 'return=minimal' });
          return entry;
        } catch (e) {
          if (e.pgCode !== '23505') throw e;
        }
      }
      throw new Error('Audit ledger is busy, please retry.');
    },
    async listAudit() { return call('GET', 'audit_log?select=*&order=seq.asc&limit=5000'); },

    async getSettings() {
      const rows = await call('GET', 'app_settings?select=*');
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async setSetting(key, value) {
      await call('POST', 'app_settings?on_conflict=key', { key, value }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    },

    async resetAll() {
      await call('DELETE', 'transactions?reference=neq.__none__');
      await call('DELETE', 'audit_log?seq=gte.0');
      await call('DELETE', 'telegram_updates?update_id=gte.0');
    },
  };
}
