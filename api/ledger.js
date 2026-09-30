// Tamper-evident audit ledger with live verification (manager only).
import { handler } from '../lib/http.js';
import { getContext } from '../lib/context.js';
import { verifyChain } from '../lib/ledger.js';
import { RuleError } from '../lib/rules.js';

export default handler(['GET'], async ({ role }) => {
  const { service } = getContext();
  const actor = await service.actorFor(role);
  if (actor.role !== 'manager') throw new RuleError('Only Svetlana can inspect the audit ledger.', 'forbidden', 403);
  const entries = await service.ledger();
  return { verification: verifyChain(entries), entries: entries.slice(-300).reverse() };
});
