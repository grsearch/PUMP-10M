'use strict';

const EMERGENCY_SELL_REASONS = new Set([
  'LOSS_CHECK_6S',
  'FIXED_STOP_LOSS',
  'EMERGENCY_STOP',
  'DEFENSE_STOP_LOSS',
  'RECONCILE_RUG',
  'RUG_PULL',
]);

function isExceededSlippageError(error) {
  const text = String(error || '');
  return /ExceededSlippage/i.test(text) ||
    /0x1774/i.test(text) ||
    /Custom(?::|"\s*:|\}\s*,?\s*)6004/i.test(text) ||
    /"Custom"\s*:\s*6004/i.test(text);
}

/**
 * PumpSwap has used two different errors for a BUY whose minimum output can
 * no longer be satisfied. Keep the SELL-only 6004 classifier above narrow,
 * while allowing the BUY path to re-quote both the legacy and current error.
 */
function isBuySlippageError(error) {
  const text = String(error || '');
  return isExceededSlippageError(text) ||
    /BuySlippageBelowMinBaseAmountOut/i.test(text) ||
    /Buy\s+Slippage\s+Below\s+Min\s+Base\s+Amount\s+Out/i.test(text) ||
    /0x1798/i.test(text) ||
    /Custom(?::|"\s*:|\}\s*,?\s*)6040/i.test(text) ||
    /"Custom"\s*:\s*6040/i.test(text);
}

/** A failed BUY loses fees, not the entire planned position size. */
function calculateBuyFailurePnlPct(feeSol, plannedEntrySol) {
  const fee = Number(feeSol);
  const entry = Number(plannedEntrySol);
  if (!Number.isFinite(fee) || fee <= 0 || !Number.isFinite(entry) || entry <= 0) return 0;
  return Math.max(-100, -(fee / entry) * 100);
}

function isEmergencySellReason(reason) {
  const value = String(reason || '');
  return EMERGENCY_SELL_REASONS.has(value) ||
    value.startsWith('HOLD_TIMEOUT_') ||
    value.startsWith('FDV_BELOW_') ||
    value.startsWith('AGE_');
}

function finiteBps(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

/**
 * PumpAmmSdk receives slippage as a percentage, while configuration is kept
 * in basis points. Normal profit exits start at the configured base. Urgent
 * exits use the emergency allowance immediately. A confirmed 6004 retry jumps
 * straight to the hard cap because repeating the same minimum-output bound
 * only burns another priority fee.
 */
function resolveSellSlippageBps({
  reason,
  attempt = 1,
  lastError,
  baseBps,
  emergencyBps,
  retryStepBps,
  maxBps,
}) {
  const hardMax = finiteBps(maxBps, 5000);
  const base = Math.min(hardMax, finiteBps(baseBps, 3000));
  const emergency = Math.min(hardMax, finiteBps(emergencyBps, 5000));
  const retryStep = finiteBps(retryStepBps, 1000);
  const attemptNumber = Math.max(1, Math.floor(Number(attempt) || 1));

  let effective = isEmergencySellReason(reason) ? emergency : base;
  if (attemptNumber > 1) {
    effective = Math.max(effective, base + retryStep * (attemptNumber - 1));
  }
  if (isExceededSlippageError(lastError)) effective = hardMax;
  return Math.min(hardMax, effective);
}

module.exports = {
  EMERGENCY_SELL_REASONS,
  calculateBuyFailurePnlPct,
  isBuySlippageError,
  isEmergencySellReason,
  isExceededSlippageError,
  resolveSellSlippageBps,
};
