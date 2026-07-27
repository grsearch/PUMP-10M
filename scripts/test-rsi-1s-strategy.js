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
const RsiCalculator = require('../src/core/RsiCalculator');
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const { config } = require('../src/config');
Module._load = originalLoad;

const BASE = 1_800_000_000_000;
const FRAME_MS = 1_000;
const MINT = 'Rsi1sTestMint1111111111111111111111111111';
const CLOSES = [100, 90, 80, 70, 60, 50, 40, 35, 80, 75];

function makeTracker(overrides = {}) {
  return new OrderFlowTracker({
    entryMode: 'RSI_CROSS_1S',
    solPriceUsd: 100,
    rsi1sPeriod: 7,
    rsi1sEntryThreshold: 30,
    rsi1sVolumeWindowMs: 60_000,
    rsi1sMinVolume60sUsd: 10_000,
    maxSignalAgeMs: 0,
    cooldownMs: 0,
    ...overrides,
  });
}

function event(index, price, solVolume = 20, suffix = '') {
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

function feed(calc, tracker, ev) {
  calc.feedTrade(ev.mint, ev.price, ev.solVolume, ev.side.toLowerCase(), ev.ts, ev.poolQuoteAfter);
  tracker.updateRsiSnapshot(ev.mint, calc.snapshot(ev.mint));
  tracker.handleSwap(ev);
}

function runClosedCandleSignalTest() {
  const calc = new RsiCalculator({ period1: 7 });
  const tracker = makeTracker();
  const signals = [];
  tracker.on('flowReversalSignal', (signal) => signals.push(signal));

  CLOSES.slice(0, 9).forEach((price, index) => feed(calc, tracker, event(index, price)));
  assert.strictEqual(signals.length, 0, 'an open 1s candle must not confirm itself');

  const confirmation = event(9, CLOSES[9]);
  feed(calc, tracker, confirmation);
  assert.strictEqual(signals.length, 1, 'the first trusted event after close must emit immediately');
  const entry = signals[0]._flow.entryRsi1s;
  assert(entry.previousRsi <= 30);
  assert(entry.currentRsi > 30);
  assert.strictEqual(entry.signalCandleTs, BASE + 8 * FRAME_MS);
  assert.strictEqual(entry.signalCloseTs, BASE + 9 * FRAME_MS);
  assert.strictEqual(entry.executionPrice, CLOSES[9]);
  assert.strictEqual(Object.hasOwn(entry, 'entryCandleTs'), false);
  assert.strictEqual(Object.hasOwn(entry, 'entryOpenPrice'), false);
  assert(entry.volume60sUsd >= 10_000);

  feed(calc, tracker, {
    ...confirmation,
    ts: confirmation.ts + 200,
    signature: 'same-bucket-second-trade',
  });
  assert.strictEqual(signals.length, 1, 'a closed candle may signal only once');

  const view = tracker.getStrategyCandidates(10, confirmation.ts);
  assert.strictEqual(view.mode, 'RSI_CROSS_1S');
  assert.strictEqual(view.candidates[0].stage, 'signaled');
  assert.strictEqual(view.thresholds.trailingActivatePct, 10);
  assert.strictEqual(view.thresholds.trailingDrawdownPct, 5);
  assert.strictEqual(view.thresholds.fdvExitThresholdUsd, 20_000);
  assert.strictEqual(view.thresholds.ageExitMs, 15 * 60_000);
  assert.strictEqual(view.thresholds.addonDropPct, 15);
  assert.strictEqual(view.thresholds.maxBuysPerMint, 2);
  assert.strictEqual(view.thresholds.fixedStopLossPct, -10);
  assert.strictEqual(view.thresholds.exitOverbought, 80);
  assert.strictEqual(view.thresholds.exitCrossDown, 70);
  assert.strictEqual(Object.hasOwn(view.thresholds, 'maxHoldMs'), false);
}

function runVolumeGateTests() {
  const blockedCalc = new RsiCalculator({ period1: 7 });
  const blocked = makeTracker();
  const blockedSignals = [];
  blocked.on('flowReversalSignal', (signal) => blockedSignals.push(signal));
  CLOSES.forEach((price, index) => feed(blockedCalc, blocked, event(index, price, 5, 'blocked')));
  assert.strictEqual(blockedSignals.length, 0);
  assert.strictEqual(blocked.states.get(MINT).rsi1sStage, 'volume-blocked');
  assert.strictEqual(blocked.states.get(MINT).rsi1sVolume60sUsd, 4_500);

  const exactCalc = new RsiCalculator({ period1: 7 });
  const exact = makeTracker();
  const exactSignals = [];
  exact.on('flowReversalSignal', (signal) => exactSignals.push(signal));
  CLOSES.slice(0, 9).forEach((price, index) => feed(exactCalc, exact, event(index, price, 10, 'exact')));
  exact.handleVolumeSwap({
    mint: MINT,
    symbol: 'RSI1',
    side: 'BUY',
    solVolume: 10,
    ts: BASE + 8 * FRAME_MS + 200,
  });
  feed(exactCalc, exact, event(9, CLOSES[9], 10, 'exact'));
  assert.strictEqual(exactSignals.length, 1, 'true volume must pass at the exact $10k boundary');
  assert.strictEqual(exactSignals[0]._flow.entryRsi1s.volume60sUsd, 10_000);
}

function runDefaultsTest() {
  assert.strictEqual(config.activityFlow.entryMode, 'RSI_CROSS_1S');
  assert.strictEqual(config.activityFlow.rsi1sPeriod, 7);
  assert.strictEqual(config.activityFlow.rsi1sEntryThreshold, 30);
  assert.strictEqual(config.activityFlow.rsi1sMinVolume60sUsd, 10_000);
  assert.strictEqual(config.strategy.positionSizeSol, 0.2);
  assert.strictEqual(config.strategy.trailingActivatePct, 10);
  assert.strictEqual(config.strategy.trailingDrawdownPct, 5);
  assert.strictEqual(Object.hasOwn(config.strategy, 'maxHoldMs'), false);
  assert.strictEqual(config.strategy.fdvExitThresholdUsd, 20_000);
  assert.strictEqual(config.strategy.ageExitMs, 15 * 60_000);
  assert.strictEqual(config.strategy.addonDropPct, 15);
  assert.strictEqual(config.strategy.maxBuysPerMint, 2);
  assert.strictEqual(config.strategy.fixedStopLossPct, -10);
  assert.strictEqual(config.strategy.rsi1sExitEnabled, true);
  assert.strictEqual(config.strategy.rsi1sOverboughtExit, 80);
  assert.strictEqual(config.strategy.rsi1sCrossDownExit, 70);
  assert.strictEqual(config.strategy.rebuyCooldownMs, 0);
}

function runDashboardContractTest() {
  for (const filename of ['dashboard.html', 'index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'public', filename), 'utf8');
    assert(html.includes('1s RSI Strategy'));
    assert(html.includes('已收盘 1s K'));
    assert(html.includes('近 60s 真实成交量'));
    assert(html.includes('FDV &lt;'));
    assert(html.includes('AGE ≥'));
    assert(html.includes('固定止损'));
    assert(html.includes('最多 ${thresholds.maxBuysPerMint'));
    assert(!html.includes('下一可成交 K 开盘'));
    assert(html.includes('移动止盈激活后屏蔽'));
    assert(!html.includes('最长持仓'));
    assert(!html.includes('最大持仓'));
    assert(!html.includes('stat-hold'));
    const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    inlineScripts.forEach((source) => new Function(source));
  }
}

runClosedCandleSignalTest();
runVolumeGateTests();
runDefaultsTest();
runDashboardContractTest();
console.log('1s RSI entry/exit strategy tests: PASS');
