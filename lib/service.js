// The processing layer. Telegram and the website both call these functions, so
// permissions, validation, commission maths, idempotent approvals, Google Sheets
// sync and Telegram notifications behave identically regardless of entry point.
// Permissions are checked here — hiding a button in the UI is only cosmetic.

import {
  RuleError, SALESPEOPLE, computeCommission, computeResults, expenseDecisionMessage, fromCents,
  normaliseReference, normaliseSplit, parseAllocation, saleDecisionMessage, splitsEqual,
  submissionMessage, toBp, toCents, validateExpenseInput, validateSaleInput, formatEuro, ALLOCATIONS,
} from './rules.js';
import { rowFor } from './sheets.js';

export function createService({ repo, sheets, telegram, now = () => new Date().toISOString() }) {
  // ---------- helpers ----------

  async function actorFor(employeeId) {
    if (!employeeId) throw new RuleError('Choose a demonstration role first.', 'no_role', 401);
    const e = await repo.getEmployee(String(employeeId));
    if (!e) throw new RuleError(`Unknown employee "${employeeId}".`, 'no_role', 401);
    return e;
  }

  async function audit(actor, action, reference, details) {
    return repo.appendAudit({ at: now(), actor: actor?.id ?? actor ?? null, action, reference, details });
  }

  async function permit(actor, roles, attempted, reference) {
    if (roles.includes(actor.role)) return;
    await audit(actor, 'denied', reference, { attempted });
    const who = `${actor.short} (${actor.title.toLowerCase()})`;
    throw new RuleError(`Denied: ${who} is not allowed to ${attempted}.`, 'forbidden', 403);
  }

  async function settings() {
    try { return await repo.getSettings(); } catch { return {}; }
  }

  async function employeesById() {
    return Object.fromEntries((await repo.listEmployees()).map((e) => [e.id, e]));
  }

  // ---------- Google Sheets ----------

  async function syncSheet(t, { reason = 'auto' } = {}) {
    const s = await settings();
    try {
      if (!sheets) throw new Error('Google Sheets is not configured on the server.');
      if (s.simulate_sheets_outage) throw new Error('Simulated Google Sheets outage (fault injection switch is ON).');
      const r = await sheets.upsert(rowFor(t, await employeesById()));
      const updated = await repo.updateTransaction(t.reference, {
        sheet_status: 'synced', sheet_error: null, sheet_synced_at: now(), sheet_row: String(r.row ?? ''),
      });
      if (reason === 'retry') await audit('system', 'sheets.retry_ok', t.reference, { row: r.row, action: r.action });
      return updated;
    } catch (err) {
      const updated = await repo.updateTransaction(t.reference, { sheet_status: 'failed', sheet_error: String(err.message).slice(0, 500) });
      await audit('system', 'sheets.failed', t.reference, { error: String(err.message).slice(0, 200) });
      return updated;
    }
  }

  // ---------- Telegram notifications ----------

  async function recipientFor(t) {
    if (t.source === 'telegram' && t.origin_chat_id) return String(t.origin_chat_id);
    const submitter = await repo.getEmployee(t.submitted_by);
    return submitter?.telegram_chat_id ? String(submitter.telegram_chat_id) : null;
  }

  async function notify(t, text) {
    const chatId = await recipientFor(t);
    if (!chatId) {
      const updated = await repo.updateTransaction(t.reference, {
        notify_status: 'no_recipient', notify_text: text, notify_chat_id: null, notify_error: 'No Telegram recipient linked',
      });
      await audit('system', 'telegram.no_recipient', t.reference, {});
      return updated;
    }
    const s = await settings();
    try {
      if (!telegram) throw new Error('Telegram bot token is not configured on the server.');
      if (s.simulate_telegram_failure) throw new Error('Simulated Telegram failure (fault injection switch is ON).');
      await telegram.sendMessage(chatId, text);
      const updated = await repo.updateTransaction(t.reference, {
        notify_status: 'sent', notify_text: text, notify_chat_id: chatId, notify_error: null, notified_at: now(),
      });
      await audit('system', 'telegram.sent', t.reference, { chat: chatId });
      return updated;
    } catch (err) {
      const updated = await repo.updateTransaction(t.reference, {
        notify_status: 'failed', notify_text: text, notify_chat_id: chatId, notify_error: String(err.message).slice(0, 500),
      });
      await audit('system', 'telegram.failed', t.reference, { error: String(err.message).slice(0, 200) });
      return updated;
    }
  }

  // ---------- submissions ----------

  async function submitSale(employeeId, input, { source = 'web', chatId = null } = {}) {
    const actor = await actorFor(employeeId);
    await permit(actor, ['sales'], 'submit sales', input?.reference);
    let v;
    try { v = validateSaleInput(input || {}); } catch (e) {
      await audit(actor, 'sale.refused', String(input?.reference ?? '').toUpperCase() || null, { reason: e.message });
      throw e;
    }
    const row = {
      reference: v.reference, kind: 'sale', submitted_by: actor.id, source, submitted_at: now(),
      customer: v.customer, project: v.project, description: v.description, amount: fromCents(v.amountCents),
      prop_richard: v.split.richard / 100, prop_anastasia: v.split.anastasia / 100, prop_jeanclaude: v.split.jeanclaude / 100,
      status: 'pending', origin_chat_id: source === 'telegram' && chatId ? String(chatId) : null,
      notify_status: 'awaiting_decision', sheet_status: 'pending',
    };
    let saved;
    try { saved = await repo.insertTransaction(row); } catch (e) {
      if (e.code === 'duplicate') await audit(actor, 'sale.refused', v.reference, { reason: 'duplicate reference' });
      throw e;
    }
    await audit(actor, 'sale.submitted', saved.reference, { source, amount: saved.amount, project: saved.project, split: v.split });
    const synced = await syncSheet(saved);
    return { transaction: synced, message: submissionMessage(synced) };
  }

  async function submitExpense(employeeId, input, { source = 'web', chatId = null } = {}) {
    const actor = await actorFor(employeeId);
    await permit(actor, ['expenses'], 'submit expenses', input?.reference);
    let v;
    try { v = validateExpenseInput(input || {}); } catch (e) {
      await audit(actor, 'expense.refused', String(input?.reference ?? '').toUpperCase() || null, { reason: e.message });
      throw e;
    }
    const at = now();
    const overhead = v.allocation === 'OVERHEAD';
    const row = {
      reference: v.reference, kind: 'expense', submitted_by: actor.id, source, submitted_at: at,
      description: v.description, amount: fromCents(v.amountCents), category: v.category,
      proposed_allocation: v.allocation,
      final_allocation: overhead ? 'OVERHEAD' : null,
      status: overhead ? 'allocated' : 'awaiting_allocation',
      decided_at: overhead ? at : null,
      origin_chat_id: source === 'telegram' && chatId ? String(chatId) : null,
      notify_status: overhead ? 'not_required' : 'awaiting_decision',
      sheet_status: 'pending',
    };
    let saved;
    try { saved = await repo.insertTransaction(row); } catch (e) {
      if (e.code === 'duplicate') await audit(actor, 'expense.refused', v.reference, { reason: 'duplicate reference' });
      throw e;
    }
    await audit(actor, 'expense.submitted', saved.reference, { source, amount: saved.amount, proposed: saved.proposed_allocation, auto_overhead: overhead });
    const synced = await syncSheet(saved);
    return { transaction: synced, message: submissionMessage(synced) };
  }

  // ---------- manager decisions ----------

  async function approveSale(employeeId, reference, splitInput = null) {
    const actor = await actorFor(employeeId);
    const ref = normaliseReference(reference);
    await permit(actor, ['manager'], 'approve sales', ref);
    const t = await repo.getTransaction(ref);
    if (!t || t.kind !== 'sale') throw new RuleError(`Sale ${ref} was not found.`, 'not_found', 404);
    if (t.status === 'approved') {
      await audit(actor, 'sale.approve_ignored', ref, { reason: 'already approved' });
      return { transaction: t, alreadyDone: true, message: `Sale ${ref} was already approved. Nothing was changed.` };
    }
    const proposed = { richard: toBp(t.prop_richard), anastasia: toBp(t.prop_anastasia), jeanclaude: toBp(t.prop_jeanclaude) };
    const split = splitInput ? normaliseSplit(splitInput) : proposed;
    const c = computeCommission(toCents(t.amount), split);
    const changed = !splitsEqual(proposed, split);
    const patch = {
      status: 'approved', decided_by: actor.id, decided_at: now(), changed,
      commission_pool: fromCents(c.pool), notify_status: 'pending',
    };
    for (const p of SALESPEOPLE) {
      patch[`appr_${p}`] = split[p] / 100;
      patch[`comm_${p}`] = fromCents(c.parts[p]);
    }
    // Compare-and-set: only a still-pending row can be approved, so double clicks,
    // retries or two managers at once can never double-count income or commission.
    const updated = await repo.updateTransactionIf(ref, 'pending', patch);
    if (!updated) {
      await audit(actor, 'sale.approve_ignored', ref, { reason: 'concurrent approval' });
      return { transaction: await repo.getTransaction(ref), alreadyDone: true, message: `Sale ${ref} was already approved. Nothing was changed.` };
    }
    await audit(actor, 'sale.approved', ref, { split, changed, pool: patch.commission_pool, parts: c.parts, rounding: c.roundingCents ? { cents: c.roundingCents, to: c.roundingTo } : null });
    const synced = await syncSheet(updated);
    const notified = await notify(synced, saleDecisionMessage(synced));
    return { transaction: notified, message: saleDecisionMessage(notified) };
  }

  async function allocateExpense(employeeId, reference, allocationInput = null) {
    const actor = await actorFor(employeeId);
    const ref = normaliseReference(reference);
    await permit(actor, ['manager'], 'allocate expenses', ref);
    const t = await repo.getTransaction(ref);
    if (!t || t.kind !== 'expense') throw new RuleError(`Expense ${ref} was not found.`, 'not_found', 404);
    if (t.status === 'allocated') {
      await audit(actor, 'expense.allocate_ignored', ref, { reason: 'already allocated' });
      return { transaction: t, alreadyDone: true, message: `Expense ${ref} was already allocated. Nothing was changed.` };
    }
    const final = allocationInput ? parseAllocation(allocationInput) : t.proposed_allocation;
    const patch = { status: 'allocated', final_allocation: final, decided_by: actor.id, decided_at: now(), changed: final !== t.proposed_allocation, notify_status: 'pending' };
    const updated = await repo.updateTransactionIf(ref, 'awaiting_allocation', patch);
    if (!updated) {
      await audit(actor, 'expense.allocate_ignored', ref, { reason: 'concurrent allocation' });
      return { transaction: await repo.getTransaction(ref), alreadyDone: true, message: `Expense ${ref} was already allocated. Nothing was changed.` };
    }
    await audit(actor, 'expense.allocated', ref, { proposed: t.proposed_allocation, final, changed: patch.changed });
    const synced = await syncSheet(updated);
    const notified = await notify(synced, expenseDecisionMessage(synced));
    return { transaction: notified, message: expenseDecisionMessage(notified) };
  }

  // ---------- retries ----------

  async function retrySheet(employeeId, reference) {
    const actor = await actorFor(employeeId);
    const ref = normaliseReference(reference);
    await permit(actor, ['manager'], 'retry Google Sheets synchronisation', ref);
    const t = await repo.getTransaction(ref);
    if (!t) throw new RuleError(`Transaction ${ref} was not found.`, 'not_found', 404);
    const updated = await syncSheet(t, { reason: 'retry' });
    return { transaction: updated, message: updated.sheet_status === 'synced' ? `${ref} synchronised to Google Sheets (same row, no duplicate).` : `Sync failed again: ${updated.sheet_error}` };
  }

  async function retryNotify(employeeId, reference) {
    const actor = await actorFor(employeeId);
    const ref = normaliseReference(reference);
    await permit(actor, ['manager'], 'retry Telegram notifications', ref);
    const t = await repo.getTransaction(ref);
    if (!t) throw new RuleError(`Transaction ${ref} was not found.`, 'not_found', 404);
    if (!['failed', 'no_recipient'].includes(t.notify_status)) {
      return { transaction: t, message: `Nothing to retry: notification status is "${t.notify_status}".` };
    }
    const text = t.notify_text || (t.kind === 'sale' ? saleDecisionMessage(t) : expenseDecisionMessage(t));
    await audit(actor, 'telegram.retry', ref, {});
    const updated = await notify(t, text);
    return { transaction: updated, message: updated.notify_status === 'sent' ? `Notification for ${ref} sent.` : `Still not delivered: ${updated.notify_error}` };
  }

  // ---------- manager setup ----------

  async function linkTelegram(employeeId, targetEmployeeId, telegramUserId) {
    const actor = await actorFor(employeeId);
    await permit(actor, ['manager'], 'change Telegram links');
    const target = await repo.getEmployee(String(targetEmployeeId));
    if (!target) throw new RuleError('Unknown employee.', 'not_found', 404);
    const uid = telegramUserId === null || telegramUserId === '' || telegramUserId === undefined ? null : String(telegramUserId).trim();
    if (uid !== null && !/^\d{3,20}$/.test(uid)) throw new RuleError('A Telegram user ID is a number, e.g. 123456789. Send /start to the bot to see yours.');
    const known = uid ? await repo.getTelegramUser(uid) : null;
    // In a private chat Telegram's chat ID equals the user ID, so this is a safe fallback.
    const chatId = uid ? String(known?.chat_id || uid) : null;
    const e = await repo.linkTelegram(target.id, uid, chatId);
    await audit(actor, uid ? 'telegram.linked' : 'telegram.unlinked', null, { employee: target.id, telegram_user_id: uid });
    return { employee: e, message: uid ? `Telegram user ${uid} is now linked to ${target.short}.` : `${target.short} has no Telegram link now.` };
  }

  async function setFault(employeeId, key, value) {
    const actor = await actorFor(employeeId);
    await permit(actor, ['manager'], 'change fault-injection switches');
    if (!['simulate_sheets_outage', 'simulate_telegram_failure'].includes(key)) throw new RuleError('Unknown switch.');
    await repo.setSetting(key, Boolean(value));
    await audit(actor, 'fault.switch', null, { [key]: Boolean(value) });
    return { message: `${key.replace(/_/g, ' ')} is now ${value ? 'ON' : 'OFF'}.` };
  }

  // ---------- reading ----------

  async function visibleTransactions(actor) {
    const all = await repo.listTransactions();
    return actor.role === 'manager' ? all : all.filter((t) => t.submitted_by === actor.id);
  }

  async function dashboard(employeeId) {
    const actor = await actorFor(employeeId);
    await permit(actor, ['manager'], 'view company financial results');
    return computeResults(await repo.listTransactions());
  }

  async function state(employeeId) {
    const actor = await actorFor(employeeId);
    const [employees, transactions] = await Promise.all([repo.listEmployees(), visibleTransactions(actor)]);
    const manager = actor.role === 'manager';
    const out = {
      actor,
      employees: employees.map((e) => (manager ? e : { id: e.id, name: e.name, short: e.short, role: e.role, title: e.title, linked: Boolean(e.telegram_user_id) })),
      transactions,
    };
    if (manager) {
      out.results = computeResults(transactions);
      out.telegramUsers = await repo.listTelegramUsers();
      out.settings = await settings();
    }
    return out;
  }

  async function ledger() {
    return repo.listAudit();
  }

  return {
    submitSale, submitExpense, approveSale, allocateExpense, retrySheet, retryNotify,
    linkTelegram, setFault, dashboard, state, ledger, audit, actorFor,
    // exposed for the bot
    repo, formatEuro, ALLOCATIONS,
  };
}
