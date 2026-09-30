// Builds the live service from server-side environment variables.
// Without Supabase credentials the app runs in a clearly labelled demo mode with
// in-memory storage (handy for local development; never used for the real submission).

import { createService } from './service.js';
import { createSupabaseRepo } from './repo-supabase.js';
import { createMemoryRepo } from './repo-memory.js';
import { createGoogleSheets, createMemorySheets } from './sheets.js';
import { createTelegramClient, createMemoryTelegram } from './telegram.js';

let cached;

export function getContext() {
  if (cached) return cached;
  const env = process.env;
  const repo = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? createSupabaseRepo({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY })
    : createMemoryRepo();
  const sheets = env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY && env.GOOGLE_SHEET_ID
    ? createGoogleSheets({
        clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        privateKey: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        spreadsheetId: env.GOOGLE_SHEET_ID,
      })
    : repo.kind === 'memory' ? createMemorySheets() : null;
  const telegram = env.TELEGRAM_BOT_TOKEN
    ? createTelegramClient({ token: env.TELEGRAM_BOT_TOKEN })
    : repo.kind === 'memory' ? createMemoryTelegram() : null;
  const service = createService({ repo, sheets, telegram });
  cached = {
    service, repo, sheets, telegram,
    mode: {
      storage: repo.kind === 'supabase' ? 'Supabase' : 'In-memory demo (not persistent)',
      sheets: sheets?.kind === 'google' ? 'Google Sheets' : sheets ? 'In-memory demo sheet' : 'Not configured',
      telegram: telegram?.kind === 'telegram' ? 'Telegram Bot API' : telegram ? 'In-memory demo bot' : 'Not configured',
      demo: repo.kind !== 'supabase',
    },
  };
  return cached;
}
