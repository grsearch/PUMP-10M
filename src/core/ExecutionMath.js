'use strict';

function estimateBuySlippagePct(state, sizeSol, tokenAmount, baseDecimals = 6) {
  if (!state || !Number.isFinite(sizeSol) || sizeSol <= 0 || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return null;
  }
  const toNumber = (value) => {
    if (value == null) return 0;
    try { return Number(value.toString()); } catch (_) { return 0; }
  };
  const baseRaw = toNumber(state.poolBaseAmount);
  const quoteRaw = toNumber(state.poolQuoteAmount);
  if (baseRaw <= 0 || quoteRaw <= 0) return null;
  const baseUi = baseRaw / Math.pow(10, baseDecimals);
  const quoteSol = quoteRaw / 1e9;
  const midPrice = quoteSol / baseUi;
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
