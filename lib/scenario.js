// Executable version of the homework brief.
// Replays Test 1, Test 2, the rule-enforcement attempts and the integration
// failure drills through the REAL processing layer (service.js + bot.js), using an
// isolated in-memory database, sheet and bot. The live data is never touched.
// Runs on the website ("Acceptance test" tab) and locally with `npm test`.

import { createService } from './service.js';
import { createMemoryRepo } from './repo-memory.js';
import { createMemorySheets } from './sheets.js';
import { createMemoryTelegram } from './telegram.js';
import { handleUpdate } from './bot.js';
import { computeCommission, computeResults } from './rules.js';
import { verifyChain } from './ledger.js';

const ME = '700000001'; // the student's own (simulated) Telegram account

export async function runScenario({ repo: injectedRepo } = {}) {
  const started = Date.now();
  let tick = Date.parse('2026-09-30T08:00:00Z');
  const now = () => new Date((tick += 1000)).toISOString();
  const repo = injectedRepo || createMemoryRepo();
  const sheets = createMemorySheets();
  const telegram = createMemoryTelegram();
  const service = createService({ repo, sheets, telegram, now });
  const deps = { service, repo, telegram };

  const checks = [];
  let section = '';
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ section, name, ok, actual, expected });
    return ok;
  };
  const expectError = async (name, fn, code) => {
    try { await fn(); checks.push({ section, name, ok: false, actual: 'accepted', expected: `refused (${code})` }); }
    catch (e) { checks.push({ section, name, ok: e.code === code, actual: `refused: ${e.message}`, expected: `refused (${code})` }); }
  };
  let updateId = 1;
  const bot = (text, from = ME) => handleUpdate({
    update_id: updateId++,
    message: { message_id: updateId, from: { id: Number(from), first_name: 'Student' }, chat: { id: Number(from), type: 'private' }, text },
  }, deps);
  const lastTo = (chat) => [...telegram.sent].reverse().find((m) => m.chatId === chat)?.text || '';
  const tx = (ref) => repo.getTransaction(ref);
  const results = async () => computeResults(await repo.listTransactions());
  const cents = (r) => ({
    A: [r.projects.A.income, r.projects.A.commission, r.projects.A.expenses, r.projects.A.result],
    B: [r.projects.B.income, r.projects.B.commission, r.projects.B.expenses, r.projects.B.result],
    company: [r.company.income, r.company.commission, r.company.allocatedExpenses, r.company.overhead, r.company.awaiting, r.company.result],
  });
  const sheetRow = (tab, ref) => sheets.tabs[tab].find((r) => r[0] === ref);
  const sheetCount = (tab, ref) => sheets.tabs[tab].filter((r) => r[0] === ref).length;

  // ------------------------------------------------------------------
  section = 'Commission rounding rules';
  const r1 = computeCommission(100000, { richard: 5000, anastasia: 3000, jeanclaude: 2000 });
  check('€1,000 at 50/30/20 → pool €100, commissions €50/€30/€20', [r1.pool, r1.parts], [10000, { richard: 5000, anastasia: 3000, jeanclaude: 2000 }]);
  const r2 = computeCommission(1005, { richard: 5000, anastasia: 5000, jeanclaude: 0 });
  check('€10.05 at 50/50/0 → pool €1.01, odd cent to Richard (tie order)', [r2.pool, r2.parts.richard, r2.parts.anastasia], [101, 51, 50]);
  const r3 = computeCommission(1005, { richard: 0, anastasia: 5000, jeanclaude: 5000 });
  check('€10.05 at 0/50/50 → odd cent to Anastasia before Jean-Claude', [r3.parts.anastasia, r3.parts.jeanclaude], [51, 50]);
  const r4 = computeCommission(33333, { richard: 3333, anastasia: 3334, jeanclaude: 3333 });
  check('€333.33 at 33.33/33.34/33.33 → parts always sum to the pool', r4.parts.richard + r4.parts.anastasia + r4.parts.jeanclaude, r4.pool);

  // ------------------------------------------------------------------
  section = 'Test 1 — Telegram entries (S01, E01)';
  await bot('/start');
  check('Unlinked user is told their Telegram ID', lastTo(ME).includes(`Your Telegram user ID is ${ME}`), true);
  await service.linkTelegram('svetlana', 'richard', ME);
  await bot('/sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000 | 50/30/20');
  check('Bot confirms S01 only after it is saved', lastTo(ME).startsWith('📝 Sale S01 recorded'), true);
  await service.linkTelegram('svetlana', 'kevin', ME);
  await bot('/expense E01 | Rented suit and fake pearl necklace for the relatives | 120 | Materials | A');
  check('Bot confirms E01 with status', lastTo(ME).includes('Awaiting allocation'), true);
  const s01 = await tx('S01');
  check('S01 keeps Richard as submitter after the link moved to Kevin', s01.submitted_by, 'richard');
  check('S01 keeps the original chat as notification destination', s01.origin_chat_id, ME);

  section = 'Test 1 — website entries (S02, E02, E03)';
  await service.submitSale('anastasia', { reference: 'S02', customer: 'Daniel King', project: 'B', description: 'University friends, dancing, and the stripping performance', amount: '2000', split: { richard: 0, anastasia: 50, jeanclaude: 50 } });
  await service.submitExpense('kevin', { reference: 'E02', description: 'Taxi for the grandmother; Kevin selected the wrong project', category: 'Travel', amount: '80', allocation: 'B' });
  await service.submitExpense('kevin', { reference: 'E03', description: 'Monthly company website subscription', category: 'Other', amount: '100', allocation: 'Company overhead' });
  check('E03 is allocated to overhead automatically', (await tx('E03')).status, 'allocated');

  section = 'Test 1 — before manager decisions';
  let res = await results();
  check('Approved income and commission are €0', [res.company.income, res.company.commission], [0, 0]);
  check('Both project results are €0', [res.projects.A.result, res.projects.B.result], [0, 0]);
  check('Company result is −€300', res.company.result, -30000);
  check('Two sales pending, two expenses awaiting allocation', [res.pending.salesCount, res.pending.expensesCount], [2, 2]);

  section = 'Test 1 — manager decisions and notifications';
  await service.approveSale('svetlana', 'S01');
  check('S01 approval notification reaches the original chat', lastTo(ME).startsWith('✅ Sale S01 approved — proposed split confirmed'), true);
  check('S01 notification status is "sent"', (await tx('S01')).notify_status, 'sent');
  await service.approveSale('svetlana', 'S02', { richard: 20, anastasia: 40, jeanclaude: 40 });
  const s02 = await tx('S02');
  check('S02 (website, Anastasia unlinked) shows no Telegram recipient', s02.notify_status, 'no_recipient');
  check('S02 final commissions €40/€80/€80', [s02.comm_richard, s02.comm_anastasia, s02.comm_jeanclaude], [40, 80, 80]);
  check('S02 keeps the original proposal 0/50/50', [s02.prop_richard, s02.prop_anastasia, s02.prop_jeanclaude], [0, 50, 50]);
  await service.allocateExpense('svetlana', 'E01');
  check('E01 allocation confirmation reaches the original chat', lastTo(ME).startsWith('📦 Expense E01 — allocation confirmed'), true);
  await service.allocateExpense('svetlana', 'E02', 'A');
  const e02msg = lastTo(ME);
  check('E02 notification highlights the change B → A', e02msg.includes('allocation CHANGED') && e02msg.includes('Proposed: Drunk University Friends') && e02msg.includes('Approved: Respectable Relatives'), true);

  section = 'Test 1 — correct results';
  res = await results();
  const t1 = cents(res);
  check('Project A: income €1,000 · commission €100 · expenses €200 · result €700', t1.A, [100000, 10000, 20000, 70000]);
  check('Project B: income €2,000 · commission €200 · expenses €0 · result €1,800', t1.B, [200000, 20000, 0, 180000]);
  check('Company: €3,000 · €300 · €200 · overhead €100 · awaiting €0 · result €2,400', t1.company, [300000, 30000, 20000, 10000, 0, 240000]);
  check('Commission earned: Richard €90 · Anastasia €110 · Jean-Claude €100', res.commissionBy, { richard: 9000, anastasia: 11000, jeanclaude: 10000 });
  check('Sheets: S02 row shows approved split 20/40/40', sheetRow('Sales', 'S02').slice(10, 13), [20, 40, 40]);
  check('Sheets: E02 row keeps proposal B and final A separately', sheetRow('Expenses', 'E02').slice(6, 8), ['Drunk University Friends', 'Respectable Relatives']);
  check('Sheets: one row per transaction (no duplicates after approval)', [sheets.tabs.Sales.length - 1, sheets.tabs.Expenses.length - 1], [2, 3]);

  // ------------------------------------------------------------------
  section = 'Test 2 — website entries';
  await service.submitSale('jeanclaude', { reference: 'S03', customer: 'Emma Stonebridge', project: 'A', description: 'Premium relatives, including an uncle presented as a surgeon', amount: '1500', split: { richard: 40, anastasia: 40, jeanclaude: 20 } });
  await service.submitSale('richard', { reference: 'S04', customer: 'Lucas Green', project: 'B', description: 'Small group of loud university friends', amount: '800', split: { richard: 25, anastasia: 25, jeanclaude: 50 } });
  await service.submitSale('richard', { reference: 'S05', customer: 'Mia Brooks', project: 'B', description: 'Extra guests and an embarrassing speech', amount: '600', split: { richard: 100, anastasia: 0, jeanclaude: 0 } });
  await service.submitExpense('kevin', { reference: 'E04', description: 'Replacement costumes after an enthusiastic dance performance', category: 'Materials', amount: '250', allocation: 'B' });
  await service.submitExpense('kevin', { reference: 'E05', description: 'Minibus for university friends; Kevin selected the wrong project again', category: 'Travel', amount: '90', allocation: 'A' });
  await service.submitExpense('kevin', { reference: 'E06', description: 'Company telephone subscription', category: 'Other', amount: '60', allocation: 'OVERHEAD' });
  await service.submitExpense('kevin', { reference: 'E07', description: 'Emergency replacement clothing; project allocation still needs checking', category: 'Materials', amount: '140', allocation: 'A' });
  check('Seven new entries saved', (await repo.listTransactions()).length, 12);

  section = 'Test 2 — manager decisions and notifications';
  await service.linkTelegram('svetlana', 'jeanclaude', ME);
  await service.approveSale('svetlana', 'S03', { richard: 20, anastasia: 30, jeanclaude: 50 });
  const s03msg = lastTo(ME);
  check('S03 message: €150 pool, split changed', s03msg.includes('split CHANGED') && s03msg.includes('total commission €150.00'), true);
  check('S03 message: Richard €30 · Anastasia €45 · Jean-Claude €75',
    ['Richard: 40% → 20% (€30.00)', 'Anastasia: 40% → 30% (€45.00)', 'Jean-Claude: 20% → 50% (€75.00)'].every((l) => s03msg.includes(l)), true);
  await service.approveSale('svetlana', 'S04');
  await service.linkTelegram('svetlana', 'kevin', ME);
  await service.allocateExpense('svetlana', 'E04');
  check('E04 confirmation delivered to Kevin\'s linked chat', lastTo(ME).startsWith('📦 Expense E04 — allocation confirmed'), true);
  await service.allocateExpense('svetlana', 'E05', 'B');
  const e05msg = lastTo(ME);
  check('E05 message: €90 moved from A to B', e05msg.includes('€90.00') && e05msg.includes('Proposed: Respectable Relatives') && e05msg.includes('Approved: Drunk University Friends'), true);
  check('S05 and E07 still pending — no decision notification sent', [(await tx('S05')).notify_status, (await tx('E07')).notify_status], ['awaiting_decision', 'awaiting_decision']);
  check('Earlier bot transactions keep their original destination', [(await tx('S01')).origin_chat_id, (await tx('E01')).origin_chat_id], [ME, ME]);

  section = 'Test 2 — cumulative results';
  res = await results();
  const t2 = cents(res);
  check('Project A: €2,500 · €250 · €200 · result €2,050', t2.A, [250000, 25000, 20000, 205000]);
  check('Project B: €2,800 · €280 · €340 · result €2,180', t2.B, [280000, 28000, 34000, 218000]);
  check('Company: €5,300 · €530 · €540 · overhead €160 · awaiting €140 · result €3,930', t2.company, [530000, 53000, 54000, 16000, 14000, 393000]);
  check('Commission: Richard €140 · Anastasia €175 · Jean-Claude €215 (total €530)', res.commissionBy, { richard: 14000, anastasia: 17500, jeanclaude: 21500 });
  check('S05 €600 remains pending and excluded', [res.pending.salesCount, res.pending.salesCents], [1, 60000]);
  check('Reconciliation: €2,050 + €2,180 − €160 − €140 = €3,930', [res.reconciliation.left, res.reconciliation.ok], [393000, true]);

  // ------------------------------------------------------------------
  section = 'Rule enforcement (totals must not move)';
  const before = JSON.stringify(await results());
  const countBefore = (await repo.listTransactions()).length;
  await expectError('Split 60/30/20 is refused until shares total 100%', () => service.submitSale('richard', { reference: 'X01', customer: 'Test', project: 'A', description: 'Bad split', amount: '100', split: { richard: 60, anastasia: 30, jeanclaude: 20 } }), 'split_total');
  await expectError('Richard cannot approve a sale', () => service.approveSale('richard', 'S05'), 'forbidden');
  await expectError('Kevin cannot submit a sale', () => service.submitSale('kevin', { reference: 'X02', customer: 'Test', project: 'A', description: 'x', amount: '100', split: { richard: 100, anastasia: 0, jeanclaude: 0 } }), 'forbidden');
  await expectError('Richard cannot allocate an expense', () => service.allocateExpense('richard', 'E07', 'B'), 'forbidden');
  await expectError('Expense with a missing amount is refused', () => service.submitExpense('kevin', { reference: 'X03', description: 'No amount', category: 'Other', amount: '', allocation: 'A' }), 'invalid');
  await expectError('Expense with a zero amount is refused', () => service.submitExpense('kevin', { reference: 'X04', description: 'Zero', category: 'Other', amount: '0', allocation: 'A' }), 'invalid');
  await expectError('Duplicate reference E01 is refused', () => service.submitExpense('kevin', { reference: 'E01', description: 'Again', category: 'Other', amount: '5', allocation: 'A' }), 'duplicate');
  await expectError('Duplicate reference is case-insensitive ("s01")', () => service.submitSale('richard', { reference: 's01', customer: 'x', project: 'A', description: 'x', amount: '5', split: { richard: 100, anastasia: 0, jeanclaude: 0 } }), 'duplicate');
  const again = await service.approveSale('svetlana', 'S01');
  check('Approving S01 a second time changes nothing', again.alreadyDone, true);
  const againE = await service.allocateExpense('svetlana', 'E02', 'B');
  check('Re-allocating an allocated expense changes nothing', [againE.alreadyDone, (await tx('E02')).final_allocation], [true, 'A']);
  await bot('/sale Z01 | Stranger | A | Sneaky sale | 100 | 100/0/0', '700000099');
  check('Unlinked Telegram user cannot submit', [(await tx('Z01')), lastTo('700000099').startsWith('⛔')], [null, true]);
  await bot('/role svetlana', '700000099');
  check('A Telegram user cannot give themselves a role', await repo.getEmployeeByTelegramUser('700000099'), null);
  await bot('/sale Z02 | Kevin tries | A | Not allowed | 100 | 100/0/0');
  check('Kevin (linked in Telegram) is denied a sale through the bot too', [(await tx('Z02')), lastTo(ME).includes('Denied')], [null, true]);
  check('Control totals unchanged after all attempts', JSON.stringify(await results()), before);
  check('No transaction was created or duplicated', (await repo.listTransactions()).length, countBefore);
  check('Denied attempts were written to the audit ledger', (await repo.listAudit()).filter((e) => e.action === 'denied').length >= 4, true);

  // ------------------------------------------------------------------
  section = 'Integration drills (sandbox copy)';
  await service.setFault('svetlana', 'simulate_sheets_outage', true);
  const preT = (await results()).company.result;
  await service.submitExpense('kevin', { reference: 'T01', description: 'Drill: safety pins', category: 'Other', amount: '10', allocation: 'A' });
  const t01 = await tx('T01');
  check('During a Sheets outage the transaction is still saved', Boolean(t01), true);
  check('…and the record reports "Sync failed"', t01.sheet_status, 'failed');
  check('…and no sheet row was written', sheetCount('Expenses', 'T01'), 0);
  const postT = (await results()).company.result;
  await service.setFault('svetlana', 'simulate_sheets_outage', false);
  await service.retrySheet('svetlana', 'T01');
  await service.retrySheet('svetlana', 'T01');
  check('Retry restores exactly one row, even when pressed twice', [(await tx('T01')).sheet_status, sheetCount('Expenses', 'T01')], ['synced', 1]);
  check('Retrying did not change financial totals', (await results()).company.result, postT);
  check('The saved expense itself counted exactly once (−€10.00)', preT - postT, 1000);

  await service.linkTelegram('svetlana', 'richard', ME);
  await service.setFault('svetlana', 'simulate_telegram_failure', true);
  await service.approveSale('svetlana', 'S05');
  const s05 = await tx('S05');
  check('Telegram failure keeps the approval', s05.status, 'approved');
  check('…and is shown as "failed", never as "sent"', s05.notify_status, 'failed');
  await service.setFault('svetlana', 'simulate_telegram_failure', false);
  await service.retryNotify('svetlana', 'S05');
  check('Retry delivers the notification', (await tx('S05')).notify_status, 'sent');
  check('Sales sheet still has one row per sale', sheetCount('Sales', 'S05'), 1);

  // ------------------------------------------------------------------
  section = 'Tamper-evident audit ledger';
  const entries = await repo.listAudit();
  const v1 = verifyChain(entries);
  check(`Ledger of ${entries.length} hash-chained entries verifies`, v1.ok, true);
  const forged = entries.map((e) => (Number(e.seq) === 5 ? { ...e, details: `${e.details} (quietly edited)` } : e));
  const v2 = verifyChain(forged);
  check('Editing entry #5 afterwards is detected at #5', [v2.ok, v2.brokenAt], [false, 5]);
  const v3 = verifyChain(entries.filter((e) => Number(e.seq) !== 7));
  check('Deleting entry #7 is detected at #7', [v3.ok, v3.brokenAt], [false, 7]);

  const passed = checks.filter((c) => c.ok).length;
  return { passed, failed: checks.length - passed, total: checks.length, ms: Date.now() - started, checks, finalResults: await results() };
}
