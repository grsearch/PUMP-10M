'use strict';

const ABSOLUTE_MAX_BUY_SLIPPAGE_PCT = 50;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Keep the on-chain max quote inside the signal-price cap.
 * Slippage values are percentages (1 means 1%), matching PumpAmmSdk.
 */
function calculateBuyPriceGuard({
  signalPrice,
  expectedPrice,
  configuredSlippagePct,
  maxPriceDeviationPct,
  inputSol,
}) {
  const signal = finitePositive(signalPrice);
  const expected = finitePositive(expectedPrice);
  const input = finitePositive(inputSol);
  const configured = Number(configuredSlippagePct);
  const maxDeviation = Number(maxPriceDeviationPct);

  if (!signal) {
    return { allowed: false, error: 'buy_price_guard: invalid signal price' };
  }
  if (!expected) {
    return { allowed: false, error: 'buy_price_guard: invalid expected price' };
  }
  if (!input) {
    return { allowed: false, error: 'buy_price_guard: invalid input amount' };
  }
  if (!Number.isFinite(configured) || configured < 0) {
    return { allowed: false, error: 'buy_price_guard: invalid configured slippage' };
  }
  if (!Number.isFinite(maxDeviation) || maxDeviation < 0) {
    return { allowed: false, error: 'buy_price_guard: invalid max price deviation' };
  }

  const maxPrice = signal * (1 + maxDeviation / 100);
  const priceDeviationPct = (expected / signal - 1) * 100;
  const tolerance = Math.max(Number.EPSILON * maxPrice * 8, 1e-18);

  if (expected - maxPrice > tolerance) {
    return {
      allowed: false,
      error: 'buy_price_guard: expected price above signal cap',
      signalPrice: signal,
      expectedPrice: expected,
      maxPrice,
      priceDeviationPct,
      remainingPct: 0,
      effectiveSlippagePct: 0,
      maxQuoteSol: input,
    };
  }

  const remainingPct = Math.max(0, (maxPrice / expected - 1) * 100);
  const effectiveSlippagePct = Math.min(
    ABSOLUTE_MAX_BUY_SLIPPAGE_PCT,
    configured,
    remainingPct,
  );

  return {
    allowed: true,
    error: null,
    signalPrice: signal,
    expectedPrice: expected,
    maxPrice,
    priceDeviationPct,
    remainingPct,
    effectiveSlippagePct,
    maxQuoteSol: input * (1 + effectiveSlippagePct / 100),
  };
}

/**
 * Resolve a pool state that is no older than maxAgeMs. A stale cache entry is
 * never used when its synchronous refresh fails; the direct RPC loader is the
 * final fallback.
 */
async function loadFreshBuyPoolState({
  poolAddress,
  maxAgeMs,
  poolStateCache,
  loadFromRpc,
  now = () => Date.now(),
}) {
  const allowedAgeMs = Number(maxAgeMs);
  if (!Number.isFinite(allowedAgeMs) || allowedAgeMs < 0) {
    throw new Error('BUY_MAX_POOL_STATE_AGE_MS must be >= 0');
  }

  const cacheAgeBeforeMs = poolStateCache?.getAge
    ? poolStateCache.getAge(poolAddress)
    : null;
  const cachedState = poolStateCache?.get
    ? poolStateCache.get(poolAddress)
    : null;

  if (
    cachedState &&
    Number.isFinite(cacheAgeBeforeMs) &&
    cacheAgeBeforeMs <= allowedAgeMs
  ) {
    return {
      state: cachedState,
      stateSource: 'cache',
      cacheBacked: true,
      cacheAgeBeforeMs,
      stateFetchedAtMs: now() - cacheAgeBeforeMs,
    };
  }

  if (poolStateCache?.refreshOne) {
    const refreshedState = await poolStateCache.refreshOne(poolAddress, {
      maxAgeMs: allowedAgeMs,
    });
    if (refreshedState) {
      const refreshedAge = poolStateCache.getAge?.(poolAddress);
      return {
        state: refreshedState,
        stateSource: 'rpc',
        cacheBacked: true,
        cacheAgeBeforeMs,
        stateFetchedAtMs: Number.isFinite(refreshedAge) ? now() - refreshedAge : now(),
      };
    }
  }

  if (typeof loadFromRpc !== 'function') {
    throw new Error('pool state refresh failed and no RPC loader is available');
  }
  const state = await loadFromRpc();
  if (!state) throw new Error('pool state RPC returned no state');
  return {
    state,
    stateSource: 'rpc',
    cacheBacked: false,
    cacheAgeBeforeMs,
    stateFetchedAtMs: now(),
  };
}

module.exports = {
  ABSOLUTE_MAX_BUY_SLIPPAGE_PCT,
  calculateBuyPriceGuard,
  loadFreshBuyPoolState,
};
