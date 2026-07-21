'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const {
  estimateBuySlippageFromQuoteReservePct,
} = require('../src/core/ExecutionMath');
const { config } = require('../src/config');
Module._load = originalLoad;

const BASE = 1_800_000_000_000;
const MINT = 'PullbackTestMint111111111111111111111111111';

function event(offsetMs, side, solVolume, price, signer, poolQuoteAfter = 100) {
  return {
    mint: MINT,
    symbol: 'PULL',
    signer,
    side,
    solVolume,
    price,
    priceBefore: price,
    priceChangePct: 0,
    ts: BASE + offsetMs,
    slot: Math.floor((BASE + offsetMs) / 400),
    signature: `sig-${offsetMs}-${signer}`,
    poolQuoteAfter,
  };
}

function tracker(overrides = {}) {
  const migrationTime = Object.prototype.hasOwnProperty.call(overrides, 'migrationTime')
    ? overrides.migrationTime
    : BASE;
  const options = { ...overrides };
  delete options.migrationTime;
  return new OrderFlowTracker({
    entryMode: 'TEN_MIN_PULLBACK',
    tokenRegistry: {
      getToken: () => ({ migration_time: migrationTime }),
    },
    solPriceUsd: 100,
    positionSizeSol: 1,
    pullbackShadowOnly: true,
    pullbackReferenceAgeMs: 600_000,
    pullbackMaxWaitMs: 300_000,
    pullbackMaxFirstSeenDelayMs: 60_000,
    pullbackMinVolumeUsd: 20_000,
    pullbackMaxVolumeUsd: 50_000,
    pullbackMinDrawdownPct: 10,
    pullbackMinReboundPct: 5,
    pullbackMaxPriceVsReferencePct: 0,
    pullbackFlowWindowMs: 15_000,
    pullbackMinUniqueBuyers: 2,
    pullbackMaxEstimatedSlippagePct: 5,
    maxSignalAgeMs: 0,
    cooldownMs: 0,
    ...options,
  });
}

function seedQualifiedFirstTenMinutes(subject, totalVolumeSol = 300) {
  subject.handleSwap(event(30_000, 'BUY', totalVolumeSol / 3, 1, 'early-a'));
  subject.handleSwap(event(300_000, 'SELL', totalVolumeSol / 3, 1, 'early-b'));
  subject.handleSwap(event(580_000, 'BUY', totalVolumeSol / 3, 1, 'reference'));
}

function runQualifiedShadowSignalTest() {
  const subject = tracker();
  const shadowSignals = [];
  const liveSignals = [];
  subject.on('shadowSignal', (signal) => shadowSignals.push(signal));
  subject.on('flowReversalSignal', (signal) => liveSignals.push(signal));

  seedQualifiedFirstTenMinutes(subject);
  subject.handleSwap(event(601_000, 'SELL', 1, 0.89, 'pullback-seller'));
  assert.strictEqual(shadowSignals.length, 0, 'a pullback alone must not signal');
  subject.handleSwap(event(606_000, 'BUY', 1, 0.92, 'recovery-a'));
  assert.strictEqual(shadowSignals.length, 0, 'a sub-5% rebound must not signal');
  subject.handleSwap(event(607_000, 'BUY', 1, 0.935, 'recovery-b'));

  assert.strictEqual(shadowSignals.length, 1);
  assert.strictEqual(liveSignals.length, 0, 'shadow mode must never enter the live buy path');
  const entry = shadowSignals[0]._flow.entry10mPullback;
  assert.strictEqual(entry.volume10mUsd, 30_000);
  assert(entry.drawdownPct >= 10);
  assert(entry.reboundPct >= 5);
  assert(entry.priceVsReferencePct <= 0);
  assert(entry.buyVolume15sSol > entry.sellVolume15sSol);
  assert.strictEqual(entry.uniqueBuyers15s, 2);
  assert(entry.estimatedSlippagePct <= 5);

  const view = subject.getStrategyCandidates(10, BASE + 607_000);
  assert.strictEqual(view.mode, 'TEN_MIN_PULLBACK');
  assert.strictEqual(view.shadowOnly, true);
  assert.strictEqual(view.candidates[0].stage, 'signaled');
  assert.strictEqual(view.summary.signaled, 1);
  assert.strictEqual(view.thresholds.minVolume10mUsd, 20_000);
  assert.strictEqual(view.thresholds.maxVolume10mUsd, 50_000);
}

function runDataCompletenessAndVolumeTests() {
  const late = tracker();
  late.handleSwap(event(60_001, 'BUY', 300, 1, 'late'));
  assert.strictEqual(late.states.get(MINT).pullbackStatus, 'ineligible');
  assert.match(late.states.get(MINT).pullbackIneligibleReason, /first eligible swap delay/);

  const unknownMigration = tracker({ migrationTime: null });
  unknownMigration.handleSwap(event(1_000, 'BUY', 300, 1, 'unknown'));
  assert.strictEqual(unknownMigration.states.get(MINT).pullbackStatus, 'ineligible');
  assert.match(unknownMigration.states.get(MINT).pullbackIneligibleReason, /migration time unavailable/);

  const tooMuchVolume = tracker();
  const shadows = [];
  tooMuchVolume.on('shadowSignal', (signal) => shadows.push(signal));
  seedQualifiedFirstTenMinutes(tooMuchVolume, 600);
  tooMuchVolume.handleSwap(event(601_000, 'SELL', 1, 0.89, 'over-volume'));
  assert.strictEqual(tooMuchVolume.states.get(MINT).pullbackStatus, 'ineligible');
  assert.match(tooMuchVolume.states.get(MINT).pullbackIneligibleReason, /10m volume/);
  assert.strictEqual(shadows.length, 0);

  const volumeOnly = tracker();
  volumeOnly.handleVolumeSwap({
    mint: MINT,
    symbol: 'PULL',
    side: 'BUY',
    solVolume: 100,
    price: null,
    ts: BASE + 20_000,
  });
  volumeOnly.handleSwap(event(300_000, 'SELL', 100, 1, 'priced-a'));
  volumeOnly.handleSwap(event(580_000, 'BUY', 100, 1, 'priced-reference'));
  volumeOnly.handleSwap(event(601_000, 'SELL', 1, 0.89, 'priced-pullback'));
  assert.strictEqual(
    volumeOnly.states.get(MINT).pullbackVolumeUsd,
    30_000,
    'valid volume must count even when that event has no trusted price',
  );
}

function runRecoveryGuardsTests() {
  const expired = tracker();
  seedQualifiedFirstTenMinutes(expired);
  expired.handleSwap(event(900_001, 'BUY', 1, 0.95, 'too-late'));
  assert.strictEqual(expired.states.get(MINT).pullbackStatus, 'expired');

  const thinPool = tracker();
  const thinSignals = [];
  thinPool.on('shadowSignal', (signal) => thinSignals.push(signal));
  seedQualifiedFirstTenMinutes(thinPool);
  thinPool.handleSwap(event(601_000, 'SELL', 1, 0.89, 'thin-seller', 10));
  thinPool.handleSwap(event(606_000, 'BUY', 1, 0.92, 'thin-a', 10));
  thinPool.handleSwap(event(607_000, 'BUY', 1, 0.935, 'thin-b', 10));
  assert.strictEqual(thinSignals.length, 0, 'estimated slippage above 5% must block the signal');
  assert.strictEqual(thinPool.states.get(MINT).pullbackLastConditions.slippage, false);

  const oneBuyer = tracker();
  const oneBuyerSignals = [];
  oneBuyer.on('shadowSignal', (signal) => oneBuyerSignals.push(signal));
  seedQualifiedFirstTenMinutes(oneBuyer);
  oneBuyer.handleSwap(event(601_000, 'SELL', 1, 0.89, 'one-seller'));
  oneBuyer.handleSwap(event(606_000, 'BUY', 1, 0.92, 'same-buyer'));
  oneBuyer.handleSwap(event(607_000, 'BUY', 1, 0.935, 'same-buyer'));
  assert.strictEqual(oneBuyerSignals.length, 0, 'repeated trades from one wallet count as one buyer');
  assert.strictEqual(oneBuyer.states.get(MINT).pullbackLastConditions.buyers15s, false);
}

function runLiveOverrideAndDefaultsTests() {
  const live = tracker({ pullbackShadowOnly: false });
  const liveSignals = [];
  live.on('flowReversalSignal', (signal) => liveSignals.push(signal));
  seedQualifiedFirstTenMinutes(live);
  live.handleSwap(event(601_000, 'SELL', 1, 0.89, 'live-seller'));
  live.handleSwap(event(606_000, 'BUY', 1, 0.92, 'live-a'));
  live.handleSwap(event(607_000, 'BUY', 1, 0.935, 'live-b'));
  assert.strictEqual(liveSignals.length, 1, 'an explicit live override may enter the existing buy pipeline');

  assert.strictEqual(estimateBuySlippageFromQuoteReservePct(100, 1), 1);
  assert.strictEqual(estimateBuySlippageFromQuoteReservePct(10, 1), 10);
  assert.strictEqual(estimateBuySlippageFromQuoteReservePct(null, 1), null);
  assert.strictEqual(config.activityFlow.entryMode, 'RSI_CROSS_15S');
  assert.strictEqual(config.activityFlow.pullbackShadowOnly, false);
  assert.strictEqual(config.activityFlow.pullbackMinVolumeUsd, 20_000);
  assert.strictEqual(config.activityFlow.pullbackMaxVolumeUsd, 50_000);
  assert.strictEqual(config.strategy.fixedStopLossPct, 0);
  assert.strictEqual(config.strategy.trailingActivatePct, 30);
  assert.strictEqual(config.strategy.trailingDrawdownPct, 8);
  assert.strictEqual(config.strategy.takeProfitPct, 0);
  assert.strictEqual(config.strategy.maxHoldMs, 300_000);
  assert.strictEqual(config.strategy.noBounceExitEnabled, false);
  assert.strictEqual(config.strategy.flowReversalExitEnabled, false);
  assert.strictEqual(config.strategy.buyMaxEstimatedSlippagePct, 5);
}

runQualifiedShadowSignalTest();
runDataCompletenessAndVolumeTests();
runRecoveryGuardsTests();
runLiveOverrideAndDefaultsTests();
console.log('Ten-minute pullback strategy tests: PASS');
