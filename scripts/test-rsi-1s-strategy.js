'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const { config } = require('../src/config');
Module._load = originalLoad;

const BASE = 1_800_000_000_000;
const FRAME_MS = 1_000;
const MINT = 'Rsi1sTestMint1111111111111111111111111111';
const PRICES = [100, 102, 105, 110, 108, 106, 104, 105];

function makeTracker(overrides = {}) {
  const token = {
    mint: MINT,
    symbol: 'RSI1',
    fdv: 50_000,
    liquidity: 8_000,
    holders: 123,
    migration_time: BASE - 120_000,
  };
  const observations = [];
  const tracker = new OrderFlowTracker({
    entryMode: 'RSI_CROSS_1S',
    solPriceUsd: 100,
    rsi1sPeriod: 7,
    rsi1sEntryThreshold: 30,
    rsi1sLiveMax: 50,
    rsi1sVolumeWindowMs: 60_000,
    rsi1sPhaseLookbackMs: 60_000,
    ema1sPeriod: 20,
    ema1sSlopeLookbackSeconds: 20,
    ema1sMinSlopePct: -0.3,
    maxSignalAgeMs: 0,
    cooldownMs: 0,
    tokenRegistry: { getToken: () => token },
    tradeLogger: { logTokenEvent: (row) => observations.push(row) },
    ...overrides,
  });
  tracker._testObservations = observations;
  return tracker;
}

function event(index, price, solVolume = 1, suffix = '') {
  return {
    mint: MINT,
    symbol: 'RSI1',
    side: index % 2 === 0 ? 'BUY' : 'SELL',
    signer: `wallet-${index}-${suffix}`,
    price,
    priceBefore: price,
    priceChangePct: 0,
    solVolume,
    ts: BASE + index * FRAME_MS + 100,
    slot: index + 1,
    signature: `sig-${index}-${suffix}`,
    poolAddress: 'pool-rsi1',
    poolQuoteAfter: 100,
  };
}

function runScenario({
  upVolume = 10,
  pullbackVolume = 2,
  emaSlope = 0,
  emaReady = true,
  liveRsi = 36,
  pullbackReady = true,
  suffix = '',
} = {}) {
  const tracker = makeTracker();
  if (!pullbackReady) {
    tracker._analyzePullbackVolume = () => ({
      ready: false,
      passed: false,
      reason: 'pullback phase unavailable',
    });
  }
  const signals = [];
  tracker.on('flowReversalSignal', (signal) => signals.push(signal));

  const volumes = [1, upVolume, upVolume, upVolume, pullbackVolume, pullbackVolume, pullbackVolume, 1];
  PRICES.forEach((price, index) => tracker.handleSwap(event(index, price, volumes[index], suffix)));

  const signalBucketTs = BASE + 7 * FRAME_MS;
  tracker.updateRsiSnapshot(MINT, {
    rsi1sPreviousClosed: 25,
    rsi1sClosed: 35,
    rsi1sLive: liveRsi,
    rsi1sClosedBars: 50,
    rsi1sCurrentBucketTs: BASE + 8 * FRAME_MS,
    rsi1sClosedBucketTs: signalBucketTs,
    rsi1sLastClosedClose: PRICES[7],
    ema1s20Closed: emaReady ? 105 : null,
    ema1s20Slope20sPct: emaReady ? emaSlope : null,
    ema1s20SlopeReady: emaReady,
    rsi1sClosedCandles: PRICES.map((close, index) => ({
      ts: BASE + index * FRAME_MS,
      close,
    })),
  });
  const confirmation = event(8, 106, 0.5, `${suffix}-confirm`);
  tracker.handleSwap(confirmation);
  return { tracker, signals, confirmation };
}

function runClosedCandleSignalTest() {
  const { tracker, signals, confirmation } = runScenario({
    upVolume: 10,
    pullbackVolume: 2,
    emaSlope: -0.1,
    suffix: 'pass',
  });
  assert.strictEqual(signals.length, 1, 'a valid closed RSI pullback signal must emit immediately');
  const entry = signals[0]._flow.entryRsi1s;
  assert(entry.previousRsi <= 30);
  assert(entry.currentRsi > 30);
  assert(entry.liveRsi <= 50);
  assert.strictEqual(entry.signalCandleTs, BASE + 7 * FRAME_MS);
  assert.strictEqual(entry.signalCloseTs, BASE + 8 * FRAME_MS);
  assert.strictEqual(entry.executionPrice, 106);
  assert.strictEqual(entry.pullbackVolumeReady, true);
  assert.strictEqual(entry.pullbackVolumePassed, true);
  assert.strictEqual(entry.upPhaseSeconds, 3);
  assert.strictEqual(entry.pullbackPhaseSeconds, 3);
  assert.strictEqual(entry.downUpVolumeRatio, 0.2);
  assert.strictEqual(entry.emaPeriod, 20);
  assert.strictEqual(entry.emaSlopeLookbackSeconds, 20);
  assert.strictEqual(entry.ema1s20Slope20sPct, -0.1);
  assert.strictEqual(entry.volume60sFilterEnabled, false);
  assert.strictEqual(entry.pullbackVolumeFilterEnabled, false);
  assert.strictEqual(entry.emaSlopeFilterEnabled, false);
  assert(
    entry.volume60sUsd < 10_000,
    'a low trailing 60-second total must be recorded without blocking the entry',
  );

  tracker.handleSwap({
    ...confirmation,
    ts: confirmation.ts + 200,
    signature: 'same-bucket-second-region',
  });
  assert.strictEqual(signals.length, 1, 'the same closed candle may signal only once');
  assert.strictEqual(tracker.states.get(MINT).rsi1sInflight, true);

  const observation = tracker._testObservations[0];
  assert.strictEqual(observation.eventType, 'RSI_BUY_POINT');
  assert.strictEqual(observation.eventKey, 'pullback_v1');
  assert.strictEqual(observation.details.downUpVolumeRatio, 0.2);
  assert(Number.isFinite(observation.details.activeBuySellRatio60s));
  assert.strictEqual(observation.details.holders, 123);
  assert.strictEqual(observation.fdv, 50_000);
  assert.strictEqual(observation.liquidity, 8_000);
  assert.strictEqual(observation.ageMs, 128_100);

  const view = tracker.getStrategyCandidates(10, confirmation.ts);
  assert.strictEqual(view.mode, 'RSI_CROSS_1S');
  assert.strictEqual(view.candidates[0].stage, 'signaled');
  assert.strictEqual(view.thresholds.volume60sFilterEnabled, false);
  assert.strictEqual(view.thresholds.pullbackVolumeFilterEnabled, false);
  assert.strictEqual(view.thresholds.emaTimeframeSeconds, 1);
  assert.strictEqual(view.thresholds.emaPeriod, 20);
  assert.strictEqual(view.thresholds.emaSlopeLookbackSeconds, 20);
  assert.strictEqual(view.thresholds.emaMinSlopePct, -0.3);
  assert.strictEqual(view.thresholds.emaWarmupPasses, true);
  assert.strictEqual(view.thresholds.emaSlopeFilterEnabled, false);
  assert.strictEqual(view.thresholds.liveRsiMax, 50);
  assert.strictEqual(view.candidates[0].downUpVolumeRatio, 0.2);
  assert.strictEqual(view.candidates[0].ema1s20Slope20sPct, -0.1);
  assert.strictEqual(view.thresholds.trailingActivatePct, 10);
  assert.strictEqual(view.thresholds.trailingDrawdownPct, 5);
  assert.strictEqual(view.thresholds.maxHoldMs, 30_000);
}

function runObservationalFilterTests() {
  const expanded = runScenario({
    upVolume: 2,
    pullbackVolume: 4,
    suffix: 'expanded-pullback',
  });
  assert.strictEqual(expanded.signals.length, 1, 'expanded pullback volume must be observation-only');
  assert.strictEqual(expanded.tracker.states.get(MINT).rsi1sPullbackVolume.downUpVolumeRatio, 2);
  assert.strictEqual(
    expanded.tracker._testObservations.length,
    1,
    'RSI buy points must retain pullback metrics for analysis',
  );

  const exact = runScenario({
    upVolume: 3,
    pullbackVolume: 3,
    suffix: 'equal-volume',
  });
  assert.strictEqual(exact.signals.length, 1, 'equal pullback and up-phase average volume must pass');
  assert.strictEqual(exact.signals[0]._flow.entryRsi1s.downUpVolumeRatio, 1);

  const coldTracker = makeTracker();
  const coldState = coldTracker._stateOf(MINT);
  const coldResult = coldTracker._analyzePullbackVolume(coldState, {
    rsi1sClosedCandles: PRICES.map((close, index) => ({
      ts: BASE + index * FRAME_MS,
      close,
      solVolume: [1, 10, 10, 10, 2, 2, 2, 1][index],
    })),
  }, BASE + 7 * FRAME_MS);
  assert.strictEqual(
    coldResult.downUpVolumeRatio,
    0.2,
    'database-prewarmed candle volume must protect pullback analysis immediately after restart',
  );
  const fallingEma = runScenario({ emaSlope: -5, suffix: 'ema-observe-only' });
  assert.strictEqual(fallingEma.signals.length, 1, 'EMA slope must not filter an RSI entry');

  const noPullbackPhase = runScenario({ pullbackReady: false, suffix: 'no-pullback-phase' });
  assert.strictEqual(
    noPullbackPhase.signals.length,
    1,
    'an unavailable pullback phase must not filter an RSI entry',
  );

  const boundary = runScenario({ emaSlope: -0.3, suffix: 'ema-boundary' });
  assert.strictEqual(boundary.signals.length, 1);

  const warming = runScenario({ emaReady: false, suffix: 'ema-warmup' });
  assert.strictEqual(
    warming.signals.length,
    1,
    'missing EMA history must not affect entry',
  );
  assert.strictEqual(warming.signals[0]._flow.entryRsi1s.emaReady, false);
  assert.strictEqual(warming.signals[0]._flow.entryRsi1s.ema1s20Slope20sPct, null);
}

function runLiveRsiCapTests() {
  const boundary = runScenario({ liveRsi: 50, suffix: 'live-rsi-boundary' });
  assert.strictEqual(boundary.signals.length, 1, 'live RSI exactly 50 must pass');

  const blocked = runScenario({ liveRsi: 50.01, suffix: 'live-rsi-blocked' });
  assert.strictEqual(blocked.signals.length, 0, 'live RSI above 50 must reject the entry');
  assert.strictEqual(blocked.tracker.states.get(MINT).rsi1sStage, 'live-rsi-blocked');
  assert.match(blocked.tracker.states.get(MINT).rsi1sWaitReason, /live RSI 50\.01>50/);
}

function runDefaultsTest() {
  assert.strictEqual(config.activityFlow.entryMode, 'RSI_CROSS_1S');
  assert.strictEqual(config.activityFlow.rsi1sPeriod, 7);
  assert.strictEqual(config.activityFlow.rsi1sEntryThreshold, 30);
  assert.strictEqual(config.activityFlow.rsi1sLiveMax, 50);
  assert.strictEqual(config.activityFlow.rsi1sPhaseLookbackMs, 60_000);
  assert.strictEqual(config.activityFlow.ema1sPeriod, 20);
  assert.strictEqual(config.activityFlow.ema1sSlopeLookbackSeconds, 20);
  assert.strictEqual(config.activityFlow.ema1sMinSlopePct, -0.3);
  assert.strictEqual(Object.hasOwn(config.activityFlow, 'rsi1sMinVolume60sUsd'), false);
  assert.strictEqual(Object.hasOwn(config.activityFlow, 'ema15sFastPeriod'), false);
  assert.strictEqual(Object.hasOwn(config.activityFlow, 'ema15sSlowPeriod'), false);
  assert.strictEqual(config.strategy.positionSizeSol, 0.2);
  assert.strictEqual(config.strategy.trailingActivatePct, 10);
  assert.strictEqual(config.strategy.trailingDrawdownPct, 5);
  assert.strictEqual(config.strategy.maxHoldMs, 30_000);
  assert.strictEqual(config.strategy.fixedStopLossPct, 0);
  assert.strictEqual(config.strategy.rsi1sExitEnabled, true);
  assert.strictEqual(config.strategy.rsi1sOverboughtExit, 80);
  assert.strictEqual(config.strategy.rsi1sCrossDownExit, 70);
  assert.strictEqual(config.strategy.rebuyCooldownMs, 0);
  assert.strictEqual(config.strategy.oneBuyPerMint, true);
  assert.strictEqual(config.strategy.maxBuysPerMint, 1);
}

function runDashboardContractTest() {
  for (const filename of ['dashboard.html', 'index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'public', filename), 'utf8');
    assert(html.includes('1s RSI First Entry'));
    assert(html.includes('thresholds.liveRsiMax ?? 50'));
    assert(html.includes('summary.liveRsiBlocked'));
    assert(html.includes('每币只允许成功开仓一次'));
    assert(html.includes('均只记录，不过滤'));
    assert(!html.includes('summary.pullbackVolumeBlocked'));
    assert(!html.includes('summary.emaSlopeBlocked'));
    assert(!html.includes('15s EMA9'));
    assert(!html.includes('15s EMA20'));
    assert(!html.includes('rsi1sMinVolume60sUsd'));
    const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    inlineScripts.forEach((source) => new Function(source));
  }
}

runClosedCandleSignalTest();
runObservationalFilterTests();
runLiveRsiCapTests();
runDefaultsTest();
runDashboardContractTest();
console.log('1s RSI first-entry strategy tests: PASS');
