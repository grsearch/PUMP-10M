'use strict';

const assert = require('assert');
const Module = require('module');
const {
  calculateBuyPriceGuard,
  loadFreshBuyPoolState,
} = require('../src/utils/buyExecutionGuard');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const SignalEngine = require('../src/core/SignalEngine');
const TradeLogger = require('../src/data/TradeLogger');
Module._load = originalLoad;

function approx(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

async function run() {
  // 1. Expected price above the configured signal cap must be rejected locally.
  const rejected = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 1.051,
    configuredSlippagePct: 50,
    maxPriceDeviationPct: 5,
    inputSol: 1,
  });
  assert.strictEqual(rejected.allowed, false);
  assert.strictEqual(rejected.error, 'buy_price_guard: expected price above signal cap');

  const productionCap = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 1.1,
    configuredSlippagePct: 50,
    maxPriceDeviationPct: 15,
    inputSol: 1,
  });
  assert.strictEqual(productionCap.allowed, true);
  approx(productionCap.expectedPrice * (1 + productionCap.effectiveSlippagePct / 100), 1.15);

  // 2. +3% expected price leaves about 1.94% before a +5% signal cap.
  const narrowed = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 1.03,
    configuredSlippagePct: 50,
    maxPriceDeviationPct: 5,
    inputSol: 1,
  });
  assert.strictEqual(narrowed.allowed, true);
  approx(narrowed.effectiveSlippagePct, (1.05 / 1.03 - 1) * 100);
  approx(narrowed.maxQuoteSol, 1.05 / 1.03);

  // 3. A configured ceiling below the remaining price room wins.
  const configuredWins = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 1.03,
    configuredSlippagePct: 1,
    maxPriceDeviationPct: 5,
    inputSol: 2,
  });
  assert.strictEqual(configuredWins.effectiveSlippagePct, 1);
  assert.strictEqual(configuredWins.maxQuoteSol, 2.02);

  // 4. A favorable expected price may use more room, but its worst on-chain
  // price still cannot exceed signal +5%.
  const favorable = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 0.95,
    configuredSlippagePct: 50,
    maxPriceDeviationPct: 5,
    inputSol: 1,
  });
  assert.strictEqual(favorable.allowed, true);
  approx(favorable.expectedPrice * (1 + favorable.effectiveSlippagePct / 100), 1.05);

  // 5. A cache older than 500ms is synchronously refreshed before use.
  let ageMs = 1_200;
  let state = { id: 'stale' };
  let refreshCalls = 0;
  const poolStateCache = {
    getAge: () => ageMs,
    get: () => state,
    refreshOne: async (poolAddress, options) => {
      refreshCalls += 1;
      assert.strictEqual(poolAddress, 'pool');
      assert.strictEqual(options.maxAgeMs, 500);
      state = { id: 'fresh' };
      ageMs = 0;
      return state;
    },
  };
  const fresh = await loadFreshBuyPoolState({
    poolAddress: 'pool',
    maxAgeMs: 500,
    poolStateCache,
    loadFromRpc: async () => assert.fail('direct RPC fallback should not be needed'),
  });
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(fresh.state.id, 'fresh');
  assert.strictEqual(fresh.stateSource, 'rpc');
  assert.strictEqual(fresh.cacheAgeBeforeMs, 1_200);

  // Supplement: BUY failure protection is read independently of the optional
  // post-sale rebuy cooldown.
  const engine = Object.create(SignalEngine.prototype);
  engine._buyFailureCooldowns = new Map();
  engine.setBuyFailureCooldown('mint', 60_000, 'BUY_CHAIN_FAILED');
  const active = engine.getActiveBuyFailureCooldown('mint');
  assert.ok(active);
  assert.strictEqual(active.reason, 'BUY_CHAIN_FAILED');
  let rejection = null;
  engine._logReject = (_signal, reason) => { rejection = reason; };
  await engine._handleEmaStrategy({ mint: 'mint', symbol: 'TEST' }, Date.now());
  assert.match(rejection, /^BUY_FAILURE_COOLDOWN: BUY_CHAIN_FAILED/);
  engine._buyFailureCooldowns.set('expired', { expireAt: Date.now() - 1, reason: 'old' });
  assert.strictEqual(engine.getActiveBuyFailureCooldown('expired'), null);

  // BUY diagnostics survive submission logging and the row is corrected when
  // reconciliation later reports BUY_CHAIN_FAILED.
  const logger = Object.create(TradeLogger.prototype);
  let insertedTrade = null;
  let failedTrade = null;
  logger.stmts = {
    insertTrade: { run: (params) => { insertedTrade = params; } },
    markBuyChainFailed: { run: (params) => { failedTrade = params; } },
  };
  const diagnostics = {
    configuredSlippagePct: 50,
    effectiveSlippagePct: 4,
    signalPrice: 1,
    expectedPrice: 1.1,
    maxPrice: 1.15,
    maxQuoteSol: 1.04,
    cacheAgeBeforeMs: 900,
    cacheAgeAtBuildMs: 2,
    stateSource: 'rpc',
  };
  logger.logTrade({
    positionId: 'position',
    mint: 'mint',
    side: 'BUY',
    success: true,
    details: diagnostics,
  });
  logger.markBuyChainFailed('position', 'Custom:6004 ExceededSlippage', diagnostics);
  assert.strictEqual(insertedTrade.success, 1);
  assert.deepStrictEqual(JSON.parse(insertedTrade.detailsJson), diagnostics);
  assert.match(failedTrade.error, /6004/);
  assert.deepStrictEqual(JSON.parse(failedTrade.detailsJson), diagnostics);

  console.log('buy execution guard tests passed');
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
