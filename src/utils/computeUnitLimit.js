'use strict';

const MIN_COMPUTE_UNIT_LIMIT = 250_000;

function resolveComputeUnitLimit(value = process.env.COMPUTE_UNIT_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MIN_COMPUTE_UNIT_LIMIT;
  return Math.max(MIN_COMPUTE_UNIT_LIMIT, parsed);
}

module.exports = {
  MIN_COMPUTE_UNIT_LIMIT,
  resolveComputeUnitLimit,
};
