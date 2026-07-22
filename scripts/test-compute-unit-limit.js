'use strict';

const assert = require('assert');
const {
  MIN_COMPUTE_UNIT_LIMIT,
  resolveComputeUnitLimit,
} = require('../src/utils/computeUnitLimit');

assert.strictEqual(MIN_COMPUTE_UNIT_LIMIT, 250_000);
assert.strictEqual(resolveComputeUnitLimit(undefined), 250_000);
assert.strictEqual(resolveComputeUnitLimit(''), 250_000);
assert.strictEqual(resolveComputeUnitLimit('invalid'), 250_000);
assert.strictEqual(resolveComputeUnitLimit('185000'), 250_000);
assert.strictEqual(resolveComputeUnitLimit(249_999), 250_000);
assert.strictEqual(resolveComputeUnitLimit(250_000), 250_000);
assert.strictEqual(resolveComputeUnitLimit(300_000), 300_000);

console.log('Compute unit limit tests: PASS');
