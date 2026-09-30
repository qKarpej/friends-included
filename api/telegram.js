// Telegram webhook. Registered once through /api/admin?action=set-webhook.
import { handler, send } from '../lib/http.js';
import { getContext } from '../lib/context.js';
import { handleUpdate } from '../lib/bot.js';

export default handler(['POST'], async ({ req, res, body }) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) return send(res, 401, { error: 'bad secret' });
  const ctx = getContext();
  try {
    await handleUpdate(body, ctx);
  } catch (err) {
    console.error('telegram update failed', err);
  }
  // Always 200 so Telegram does not retry forever; duplicates are ignored by update_id anyway.
  return { ok: true };
});
