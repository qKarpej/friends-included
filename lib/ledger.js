// Tamper-evident audit ledger.
// Every action (submission, approval, denied attempt, link change, sync result...)
// becomes one entry whose SHA-256 hash covers its own content AND the previous
// entry's hash. Editing or deleting any past row in the database breaks every
// hash after it, and "Verify ledger" on the website points at the exact row.

import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

export function entryHash({ seq, prev_hash, at, actor, action, reference, details }) {
  const material = [seq, prev_hash, at, actor ?? '', action, reference ?? '', details ?? ''].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export function buildEntry(last, { at, actor, action, reference, details }) {
  const seq = last ? Number(last.seq) + 1 : 1;
  const prev_hash = last ? last.hash : GENESIS;
  const entry = {
    seq,
    prev_hash,
    at,
    actor: actor ?? null,
    action,
    reference: reference ?? null,
    details: details === undefined ? '' : typeof details === 'string' ? details : JSON.stringify(details),
  };
  entry.hash = entryHash(entry);
  return entry;
}

export function verifyChain(entries) {
  const sorted = [...entries].sort((a, b) => Number(a.seq) - Number(b.seq));
  let prev = GENESIS;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (Number(e.seq) !== i + 1) return { ok: false, count: sorted.length, brokenAt: i + 1, reason: `Entry #${i + 1} is missing (a row was deleted).` };
    if (e.prev_hash !== prev) return { ok: false, count: sorted.length, brokenAt: e.seq, reason: `Entry #${e.seq} no longer points at the hash of #${e.seq - 1}.` };
    if (entryHash(e) !== e.hash) return { ok: false, count: sorted.length, brokenAt: e.seq, reason: `Entry #${e.seq} was edited after it was written.` };
    prev = e.hash;
  }
  return { ok: true, count: sorted.length, head: prev };
}
