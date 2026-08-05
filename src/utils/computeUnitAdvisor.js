'use strict';

function finitePositiveIntegers(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function nearestRankPercentile(sortedValues, percentile) {
  if (!sortedValues.length) return null;
  const p = Math.min(1, Math.max(0, Number(percentile) || 0));
  const rank = Math.max(1, Math.ceil(p * sortedValues.length));
  return sortedValues[Math.min(sortedValues.length - 1, rank - 1)];
}

/**
 * Recommend a BUY compute-unit limit from successful on-chain samples.
 *
 * The advisor intentionally waits for a meaningful sample before changing the
 * configured limit. The recommendation is P99 plus a safety margin, rounded
 * up, and then clamped to the production safety range.
 */
function recommendComputeUnitLimit(samples, {
  minSamples = 20,
  percentile = 0.99,
  safetyMultiplier = 1.10,
  minLimit = 250_000,
  maxLimit = 400_000,
  roundTo = 1_000,
} = {}) {
  const clean = finitePositiveIntegers(samples).sort((a, b) => a - b);
  const required = Math.max(1, Number.parseInt(String(minSamples), 10) || 20);
  const safeMin = Math.max(1, Number.parseInt(String(minLimit), 10) || 250_000);
  const safeMax = Math.max(safeMin, Number.parseInt(String(maxLimit), 10) || 400_000);
  const step = Math.max(1, Number.parseInt(String(roundTo), 10) || 1_000);
  const multiplier = Math.max(1, Number(safetyMultiplier) || 1.10);
  const p99 = nearestRankPercentile(clean, percentile);

  if (clean.length < required || p99 == null) {
    return {
      ready: false,
      sampleCount: clean.length,
      minSamples: required,
      percentileValue: p99,
      recommendedLimit: null,
    };
  }

  const raw = Math.ceil((p99 * multiplier) / step) * step;
  const recommendedLimit = Math.max(safeMin, Math.min(safeMax, raw));
  return {
    ready: true,
    sampleCount: clean.length,
    minSamples: required,
    percentileValue: p99,
    safetyMultiplier: multiplier,
    rawLimit: raw,
    recommendedLimit,
    clamped: raw !== recommendedLimit,
  };
}

module.exports = {
  nearestRankPercentile,
  recommendComputeUnitLimit,
};
