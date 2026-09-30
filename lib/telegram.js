// Telegram Bot API client (sendMessage) plus an in-memory stand-in for tests.

export function createTelegramClient({ token }) {
  return {
    kind: 'telegram',
    async sendMessage(chatId, text) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(`Telegram refused the message: ${data.description || res.status}`);
      return data.result;
    },
    async call(method, body) {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      return res.json();
    },
  };
}

export function createMemoryTelegram() {
  const sent = [];
  return {
    kind: 'memory',
    sent,
    async sendMessage(chatId, text) { sent.push({ chatId: String(chatId), text }); return { message_id: sent.length }; },
    async call() { return { ok: true }; },
  };
}
