import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinAgentTools } from './builtin-agent-tools.mjs';

const [calculator, localDateTime] = createBuiltinAgentTools({
  now: () => new Date('2026-10-09T23:03:45.000Z'),
});

test('calculator evaluates bounded arithmetic without evaluating code', async () => {
  assert.deepEqual(await calculator.execute({ expression: '2 + 3 * (4 - 1)' }), {
    expression: '2 + 3 * (4 - 1)',
    result: 11,
  });
  assert.equal((await calculator.execute({ expression: '2^3^2' })).result, 512);
  assert.equal((await calculator.execute({ expression: 'sqrt(2) + sin(pi / 2)' })).result, Math.SQRT2 + 1);
  assert.equal((await calculator.execute({ expression: 'min(3, 5, -2)' })).result, -2);
  await assert.rejects(calculator.execute({ expression: 'globalThis.process.exit()' }), /Unsupported expression/u);
});

test('calculator rejects malformed, oversized, unknown, and non-finite expressions', async () => {
  for (const expression of ['', '1 +', '1 2', 'unknown']) {
    assert.ok(calculator.validate_input({ expression }));
    await assert.rejects(calculator.execute({ expression }));
  }
  assert.match(calculator.validate_input({ expression: '1 / 0' }), /finite number/u);
  assert.match(calculator.validate_input({ expression: 'sqrt(-1)' }), /finite number/u);
  await assert.rejects(calculator.execute({ expression: '1 / 0' }), /finite number/u);
  await assert.rejects(calculator.execute({ expression: 'sqrt(-1)' }), /finite number/u);
  assert.match(calculator.validate_input({ expression: '1'.repeat(257) }), /characters/u);
  assert.match(calculator.validate_input({ expression: '2', unexpected: true }), /Unsupported argument/u);
});

test('local date-time reports ISO time and the machine local time zone', async () => {
  const result = await localDateTime.execute({});
  assert.equal(result.iso, '2026-10-09T23:03:45.000Z');
  assert.equal(typeof result.local, 'string');
  assert.ok(result.local.length > 0);
  assert.equal(result.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});
