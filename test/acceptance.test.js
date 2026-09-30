import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../lib/scenario.js';

test('homework acceptance scenario (Test 1, Test 2, rules, integration, ledger)', async () => {
  const r = await runScenario();
  for (const c of r.checks) {
    const mark = c.ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  [${c.section}] ${c.name}${c.ok ? '' : `\n      expected ${JSON.stringify(c.expected)}\n      actual   ${JSON.stringify(c.actual)}`}`);
  }
  console.log(`\n${r.passed}/${r.total} checks passed in ${r.ms} ms`);
  assert.equal(r.failed, 0);
});
