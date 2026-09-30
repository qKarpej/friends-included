// In-memory repository with exactly the same interface and guarantees as the
// Supabase repository (unique references, conditional "only if still pending"
// updates, append-only chained ledger). Used by the built-in acceptance test and
// by local demo mode when no Supabase credentials are configured.

import { EMPLOYEES } from './employees.js';
import { buildEntry } from './ledger.js';
import { RuleError } from './rules.js';

const clone = (x) => (x === null || x === undefined ? x : JSON.parse(JSON.stringify(x)));

export function createMemoryRepo() {
  const employees = new Map(EMPLOYEES.map((e) => [e.id, { ...e, telegram_user_id: null, telegram_chat_id: null }]));
  const telegramUsers = new Map();
  const transactions = new Map();
  const audit = [];
  const settings = new Map();
  const updates = new Set();

  return {
    kind: 'memory',

    async listEmployees() { return [...employees.values()].map(clone); },
    async getEmployee(id) { return clone(employees.get(id) || null); },
    async getEmployeeByTelegramUser(userId) {
      return clone([...employees.values()].find((e) => String(e.telegram_user_id) === String(userId)) || null);
    },
    async linkTelegram(employeeId, userId, chatId) {
      for (const e of employees.values()) {
        if (userId !== null && String(e.telegram_user_id) === String(userId)) { e.telegram_user_id = null; e.telegram_chat_id = null; }
      }
      const e = employees.get(employeeId);
      e.telegram_user_id = userId;
      e.telegram_chat_id = chatId;
      return clone(e);
    },

    async upsertTelegramUser(u) {
      telegramUsers.set(String(u.user_id), { ...(telegramUsers.get(String(u.user_id)) || {}), ...u });
    },
    async listTelegramUsers() { return [...telegramUsers.values()].map(clone); },
    async getTelegramUser(userId) { return clone(telegramUsers.get(String(userId)) || null); },

    async markUpdateProcessed(updateId) {
      if (updates.has(updateId)) return false;
      updates.add(updateId);
      return true;
    },

    async insertTransaction(row) {
      if (transactions.has(row.reference)) throw new RuleError(`Reference ${row.reference} already exists. Use a new, unique reference.`, 'duplicate', 409);
      transactions.set(row.reference, clone(row));
      return clone(row);
    },
    async getTransaction(ref) { return clone(transactions.get(ref) || null); },
    async listTransactions() {
      return [...transactions.values()].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)).map(clone);
    },
    /** Atomic compare-and-set: only updates while status still equals expectedStatus. */
    async updateTransactionIf(ref, expectedStatus, patch) {
      const t = transactions.get(ref);
      if (!t || t.status !== expectedStatus) return null;
      Object.assign(t, clone(patch));
      return clone(t);
    },
    async updateTransaction(ref, patch) {
      const t = transactions.get(ref);
      if (!t) return null;
      Object.assign(t, clone(patch));
      return clone(t);
    },

    async appendAudit(fields) {
      const entry = buildEntry(audit[audit.length - 1], fields);
      audit.push(entry);
      return clone(entry);
    },
    async listAudit() { return audit.map(clone); },

    async getSettings() { return Object.fromEntries(settings); },
    async setSetting(key, value) { settings.set(key, value); },

    async resetAll() {
      transactions.clear(); audit.length = 0; updates.clear();
    },
  };
}
