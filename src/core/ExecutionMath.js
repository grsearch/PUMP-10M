'use strict';

const { priceDetailsFromRawState } = require('../utils/pumpSwapPricing');

function estimateBuySlippagePct(state, sizeSol, tokenAmount, baseDecimals = 6) {
  if (!state || !Number.isFinite(sizeSol) || sizeSol <= 0 || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return null;
  }
  const midPrice = priceDetailsFromRawState(state, baseDecimals)?.effectivePrice || null;
  const executionPrice = sizeSol / tokenAmount;
  if (!Number.isFinite(midPrice) || midPrice <= 0 || !Number.isFinite(executionPrice) || executionPrice <= 0) {
    return null;
  }
  return Math.max(0, ((executionPrice / midPrice) - 1) * 100);
}

function estimateBuySlippageFromQuoteReservePct(poolQuoteSol, sizeSol) {
  if (!Number.isFinite(poolQuoteSol) || poolQuoteSol <= 0 || !Number.isFinite(sizeSol) || sizeSol <= 0) {
    return null;
  }

  // For a constant-product pool, average buy execution moves away from the
  // pre-trade mid by approximately quoteIn / quoteReserve. The Executor still
  // applies the SDK quote-based guard immediately before a live submission;
  // this estimate lets the entry state machine reject an obviously thin pool
  // before it emits a signal.
  return (sizeSol / poolQuoteSol) * 100;
}

module.exports = { estimateBuySlippagePct, estimateBuySlippageFromQuoteReservePct };
