// Tiny helpers shared by the Vercel functions in /api.
import { RuleError } from './rules.js';

export async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** The website's "Demonstration role" selector sends the chosen employee in this header. */
export const roleOf = (req) => String(req.headers['x-demo-role'] || '').trim() || null;

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export function handler(methods, fn) {
  return async (req, res) => {
    if (!methods.includes(req.method)) return send(res, 405, { error: `Use ${methods.join(' or ')}.` });
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const url = new URL(req.url, 'http://local');
      const query = Object.fromEntries(url.searchParams);
      const out = await fn({ req, res, body, query, role: roleOf(req) });
      if (!res.writableEnded) send(res, 200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof RuleError) return send(res, err.status, { error: err.message, code: err.code });
      console.error(err);
      send(res, 500, { error: 'Server error. The action may not have completed; check the record and retry.', detail: String(err.message).slice(0, 300) });
    }
  };
}
