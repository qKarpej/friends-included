// Public page configuration (no secrets): who built it and where the linked resources live.
import { handler } from '../lib/http.js';
import { getContext } from '../lib/context.js';

export default handler(['GET'], async () => {
  const env = process.env;
  return {
    studentName: env.STUDENT_NAME || 'Student name (set STUDENT_NAME in Vercel)',
    botUsername: env.TELEGRAM_BOT_USERNAME || null,
    sheetUrl: env.GOOGLE_SHEET_ID ? `https://docs.google.com/spreadsheets/d/${env.GOOGLE_SHEET_ID}/edit` : null,
    githubUrl: env.GITHUB_REPO_URL || null,
    mode: getContext().mode,
  };
});
