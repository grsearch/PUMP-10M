'use strict';

const assert = require('assert');
const {
  MIN_COMPUTE_UNIT_LIMIT,
  resolveComputeUnitLimit,
} = require('../src/utils/computeUnitLimit');
const { recommendComputeUnitLimit } = require('../src/utils/computeUnitAdvisor');
const PriorityFeeOracle = require('../src/utils/priorityFeeOracle');

assert.strictEqual(MIN_COMPUTE_UNIT_LIMIT, 250_000);
assert.strictEqual(resolveComputeUnitLimit(undefined), 250_000);
assert.strictEqual(resolveComputeUnitLimit(''), 250_000);
assert.strictEqual(resolveComputeUnitLimit('invalid'), 250_000);
assert.strictEqual(resolveComputeUnitLimit('185000'), 250_000);
assert.strictEqual(resolveComputeUnitLimit(249_999), 250_000);
assert.strictEqual(resolveComputeUnitLimit(250_000), 250_000);
assert.strictEqual(resolveComputeUnitLimit(300_000), 300_000);

const insufficient = recommendComputeUnitLimit([180_000, 190_000], { minSamples: 3 });
assert.strictEqual(insufficient.ready, false);
assert.strictEqual(insufficient.sampleCount, 2);

const recommended = recommendComputeUnitLimit(
  [180_000, 190_000, 200_000, 210_000, 220_000],
  { minSamples: 5, safetyMultiplier: 1.10 },
);
assert.strictEqual(recommended.ready, true);
assert.strictEqual(recommended.percentileValue, 220_000);
assert.strictEqual(recommended.recommendedLimit, 250_000);

const elevated = recommendComputeUnitLimit(
  Array.from({ length: 20 }, (_, index) => 260_000 + index * 1_000),
  { minSamples: 20, safetyMultiplier: 1.10 },
);
assert.strictEqual(elevated.percentileValue, 279_000);
assert.strictEqual(elevated.recommendedLimit, 307_000);

const clamped = recommendComputeUnitLimit(
  Array.from({ length: 20 }, () => 390_000),
  { minSamples: 20, safetyMultiplier: 1.10, maxLimit: 400_000 },
);
assert.strictEqual(clamped.recommendedLimit, 400_000);
assert.strictEqual(clamped.clamped, true);

const oracle = Object.create(PriorityFeeOracle.prototype);
oracle.cuLimit = 400_000;
oracle._cachedLevels = { veryHigh: 1 };
let fee = oracle.estimate('BUY');
assert.strictEqual(fee.totalLamports, 3_000_000, 'BUY fee must keep the staged floor');
assert.strictEqual(fee.microLamportsPerCu, 7_500_000);
oracle._cachedLevels = { veryHigh: 1_000_000_000 };
fee = oracle.estimate('BUY');
assert.strictEqual(fee.totalLamports, 5_000_000, 'BUY fee must keep the staged cap');

console.log('Compute unit limit tests: PASS');
process.exit(0);
