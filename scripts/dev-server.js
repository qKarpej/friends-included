// Local development server: serves /public and runs the /api functions the same
// way Vercel does. Without Supabase env vars it runs in in-memory demo mode.
//   npm run dev   → http://localhost:3000
// Local-only extra: POST /__bot {"from":"123","text":"/start"} simulates a Telegram message
// and returns what the bot would have replied.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === '/__bot' && req.method === 'POST') {
      const { getContext } = await import('../lib/context.js');
      const { handleUpdate } = await import('../lib/bot.js');
      const ctx = getContext();
      const chunks = []; for await (const c of req) chunks.push(c);
      const { from, text } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const before = ctx.telegram.sent?.length || 0;
      await handleUpdate({ update_id: Date.now(), message: { from: { id: Number(from), first_name: 'Local tester' }, chat: { id: Number(from), type: 'private' }, text } }, ctx);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ replies: (ctx.telegram.sent || []).slice(before) }));
    }
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z-]/gi, '');
      const mod = await import(`../api/${name}.js`);
      return mod.default(req, res);
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (!path || path.endsWith('/') || path.endsWith('\\')) path = join(path, 'index.html');
    const file = join(root, 'public', path);
    if (!file.startsWith(join(root, 'public'))) { res.statusCode = 403; return res.end(); }
    const data = await readFile(file);
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch (err) {
    res.statusCode = err.code === 'ENOENT' || err.code === 'ERR_MODULE_NOT_FOUND' ? 404 : 500;
    res.end(res.statusCode === 404 ? 'Not found' : String(err.stack));
  }
}).listen(port, () => console.log(`Friends Included running at http://localhost:${port}`));
