// Telegram bot conversation. Identity comes only from Telegram's user ID and the
// manager's link table: there is no command that lets a user pick their own role.

import { ALLOCATIONS, RuleError, formatEuro, parseSplitText } from './rules.js';

const HELP_SALE = [
  'Sale format (one line, fields separated by |):',
  '/sale REF | Customer | Project A or B | Description | Amount | Richard/Anastasia/Jean-Claude %',
  '',
  'Example:',
  '/sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000 | 50/30/20',
].join('\n');

const HELP_EXPENSE = [
  'Expense format (one line, fields separated by |):',
  '/expense REF | Description | Amount | Materials/Travel/Other | A, B or Overhead',
  '',
  'Example:',
  '/expense E01 | Rented suit and fake pearl necklace for the relatives | 120 | Materials | A',
].join('\n');

const STATUS = {
  pending: '⏳ pending approval', approved: '✅ approved',
  awaiting_allocation: '⏳ awaiting allocation', allocated: '✅ allocated',
};

function splitFields(rest, expected, help) {
  const parts = rest.split('|').map((s) => s.trim());
  if (parts.length !== expected || parts.some((p) => p === '')) {
    const got = rest.trim() ? parts.filter(Boolean).length : 0;
    throw new RuleError(`I need ${expected} fields but found ${got}. Nothing was recorded.\n\n${help}`);
  }
  return parts;
}

export async function handleUpdate(update, { service, repo, telegram }) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.from) return { handled: false };
  if (update.update_id !== undefined && !(await repo.markUpdateProcessed(update.update_id))) {
    return { handled: false, duplicate: true }; // Telegram re-delivered an update we already processed
  }

  const userId = String(msg.from.id);
  const chatId = String(msg.chat.id);
  await repo.upsertTelegramUser({
    user_id: userId, chat_id: chatId,
    username: msg.from.username || null,
    first_name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || null,
    last_seen: new Date().toISOString(),
  });

  const reply = (text) => telegram.sendMessage(chatId, text);
  const text = String(msg.text || '').trim();
  const m = text.match(/^\/([a-zA-Z_]+)(?:@\w+)?\s*([\s\S]*)$/);
  const command = m ? m[1].toLowerCase() : null;
  const rest = m ? m[2] : text;
  const employee = await repo.getEmployeeByTelegramUser(userId);

  if (command === 'start' || command === 'whoami' || (!command && !employee)) {
    if (!employee) {
      await reply([
        '👋 Welcome to Friends Included Ltd — all friendships expire at checkout.',
        '',
        `Your Telegram user ID is ${userId}.`,
        'You are not linked to an employee yet, so you cannot submit transactions.',
        'Ask Svetlana to link this ID in “Manager setup” on the website, then send /help.',
      ].join('\n'));
    } else {
      await reply([
        `👋 Hello ${employee.short}! You are linked as ${employee.title} (Telegram ID ${userId}).`,
        employee.role === 'sales' ? 'Send /sale to report a sale.' : employee.role === 'expenses' ? 'Send /expense to report an expense.' : 'Manager decisions are made on the website.',
        'Send /help for formats, /mine for your submissions.',
      ].join('\n'));
    }
    return { handled: true };
  }

  if (!employee) {
    await reply(`⛔ This Telegram account (ID ${userId}) is not linked to any employee, so nothing was recorded. Ask Svetlana to link it in Manager setup.`);
    return { handled: true };
  }

  try {
    switch (command) {
      case 'help':
        await reply([
          `You are ${employee.short} (${employee.title}).`, '',
          employee.role === 'sales' ? HELP_SALE : employee.role === 'expenses' ? HELP_EXPENSE : 'Svetlana approves sales and allocations on the website.',
          '', '/mine — your latest submissions and statuses',
        ].join('\n'));
        break;

      case 'sale': {
        if (!rest.trim()) { await reply(HELP_SALE); break; }
        if (employee.role !== 'sales') {
          // Let the processing layer deny it so the attempt is logged in the audit ledger.
          await service.submitSale(employee.id, {}, { source: 'telegram', chatId });
        }
        const [reference, customer, project, description, amount, splitText] = splitFields(rest, 6, HELP_SALE);
        const split = parseSplitText(splitText);
        const toPct = (bp) => bp / 100;
        const r = await service.submitSale(employee.id, {
          reference, customer, project, description, amount,
          split: { richard: toPct(split.richard), anastasia: toPct(split.anastasia), jeanclaude: toPct(split.jeanclaude) },
        }, { source: 'telegram', chatId });
        await reply(r.message);
        break;
      }

      case 'expense': {
        if (!rest.trim()) { await reply(HELP_EXPENSE); break; }
        if (employee.role !== 'expenses') await service.submitExpense(employee.id, {}, { source: 'telegram', chatId });
        const [reference, description, amount, category, allocation] = splitFields(rest, 5, HELP_EXPENSE);
        const r = await service.submitExpense(employee.id, { reference, description, amount, category, allocation }, { source: 'telegram', chatId });
        await reply(r.message);
        break;
      }

      case 'mine': {
        const all = (await repo.listTransactions()).filter((t) => t.submitted_by === employee.id).slice(-10);
        await reply(all.length
          ? ['Your latest submissions:', ...all.map((t) => `${t.reference} · ${formatEuro(t.amount)} · ${t.kind === 'sale' ? `project ${t.project}` : ALLOCATIONS[t.final_allocation || t.proposed_allocation]} · ${STATUS[t.status]}`)].join('\n')
          : 'You have not submitted anything yet.');
        break;
      }

      default:
        await reply('I did not understand that. Send /help to see the formats.');
    }
  } catch (err) {
    if (err instanceof RuleError) await reply(`❌ Not recorded. ${err.message}`);
    else { await reply('❌ Not recorded: a server error occurred. Please try again in a moment.'); throw err; }
  }
  return { handled: true };
}
