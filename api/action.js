// Single entry point for every website action. Each action goes through the
// same processing layer as the Telegram bot, which enforces the role permissions.
import { handler } from '../lib/http.js';
import { getContext } from '../lib/context.js';
import { RuleError } from '../lib/rules.js';

export default handler(['POST'], async ({ body, role }) => {
  const s = getContext().service;
  switch (body.action) {
    case 'submitSale': return s.submitSale(role, body.data, { source: 'web' });
    case 'submitExpense': return s.submitExpense(role, body.data, { source: 'web' });
    case 'approveSale': return s.approveSale(role, body.reference, body.split || null);
    case 'allocateExpense': return s.allocateExpense(role, body.reference, body.allocation || null);
    case 'retrySheet': return s.retrySheet(role, body.reference);
    case 'retryNotify': return s.retryNotify(role, body.reference);
    case 'linkTelegram': return s.linkTelegram(role, body.employeeId, body.telegramUserId);
    case 'setFault': return s.setFault(role, body.key, body.value);
    default: throw new RuleError('Unknown action.');
  }
});
