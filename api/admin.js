// One-off administration, protected by ADMIN_SECRET (never shown on the website).
//   POST /api/admin?action=set-webhook      → registers https://<this host>/api/telegram with Telegram
//   POST /api/admin?action=webhook-info     → shows Telegram's view of the webhook
//   POST /api/admin?action=reset            → deletes ALL transactions + ledger and clears the sheet rows
//                                             (use once, before Test 1, to remove practice data)
import { handler, send } from '../lib/http.js';
import { getContext } from '../lib/context.js';

export default handler(['POST'], async ({ req, res, query }) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) return send(res, 401, { error: 'Missing or wrong x-admin-secret header.' });
  const { repo, sheets, telegram } = getContext();
  if (query.action === 'set-webhook') {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = `https://${host}/api/telegram`;
    const r = await telegram.call('setWebhook', {
      url, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
      allowed_updates: ['message'], drop_pending_updates: true,
    });
    await telegram.call('setMyCommands', { commands: [
      { command: 'start', description: 'Show my Telegram ID and link status' },
      { command: 'sale', description: 'Report a sale (salespeople)' },
      { command: 'expense', description: 'Report an expense (Kevin)' },
      { command: 'mine', description: 'My latest submissions and statuses' },
      { command: 'help', description: 'Formats and examples' },
    ] });
    return { url, telegram: r };
  }
  if (query.action === 'webhook-info') return telegram.call('getWebhookInfo', {});
  if (query.action === 'reset') {
    await repo.resetAll();
    if (sheets) await sheets.clearData();
    return { ok: true, message: 'All transactions, ledger entries and sheet rows removed. Employees and Telegram links kept.' };
  }
  return send(res, 400, { error: 'Unknown action.' });
});
