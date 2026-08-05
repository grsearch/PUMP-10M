'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const DropReboundTracker = require('../src/core/DropReboundTracker');
const { config, validateConfig } = require('../src/config');
Module._load = originalLoad;

function registryFor(base, overrides = {}) {
  const token = {
    is_active: 1,
    symbol: 'TEST',
    fdv: 50_000,
    liquidity: 5_000,
    migration_time: base - 60_000,
    ...overrides,
  };
  return { getToken: () => token };
}

function swap(mint, price, ts, id) {
  return {
    mint,
    symbol: 'TEST',
    side: price < 1 ? 'SELL' : 'BUY',
    price,
    solVolume: 1,
    ts,
    signature: id,
    poolQuoteAfter: 40,
  };
}

function tracker(base, tokenOverrides = {}) {
  return new DropReboundTracker({
    tokenRegistry: registryFor(base, tokenOverrides),
    maxSignalAgeMs: 10_000,
  });
}

function run() {
  assert.deepStrictEqual(validateConfig().filter((message) => message.includes('drop') || message.includes('rebound')), []);
  assert.strictEqual(config.activityFlow.entryMode, 'DROP_REBOUND_1S');
  assert.strictEqual(config.activityFlow.dropWindowMs, 1_000);
  assert.strictEqual(config.activityFlow.dropMinPct, 18);
  assert.strictEqual(config.activityFlow.dropMaxPct, 22);
  assert.strictEqual(config.activityFlow.reboundMinPct, 2);
  assert.strictEqual(config.activityFlow.reboundMaxPct, 5);
  assert.strictEqual(config.activityFlow.reboundTimeoutMs, 1_000);
  assert.strictEqual(config.activityFlow.entryMaxTokenAgeMs, 180_000);
  assert.strictEqual(config.strategy.maxTokenAgeMs, 5 * 60_000);
  assert.strictEqual(config.strategy.minFdVUsd, 10_000);
  assert.strictEqual(config.strategy.maxFdVUsd, 500_000);
  assert.strictEqual(config.strategy.minLiquidityUsd, 0);
  assert.strictEqual(config.pumpDiscovery.enabled, true);

  const base = Date.now() - 2_000;
  const mint = 'DropReboundMint111111111111111111111111111';

  {
    const t = tracker(base);
    const signals = [];
    t.on('flowReversalSignal', (signal) => signals.push(signal));
    t.handleSwap(swap(mint, 1, base, 'ok-peak'));
    t.handleSwap(swap(mint, 0.81, base + 400, 'ok-drop'));
    assert.strictEqual(t.states.get(mint).stage, 'waiting');
    t.handleSwap(swap(mint, 0.8272, base + 900, 'ok-rebound'));
    assert.strictEqual(signals.length, 1);
    assert(signals[0]._flow.entryDropRebound1s);
    const entry = signals[0]._flow.entryDropRebound1s;
    assert.strictEqual(entry.candidateStartedAt, base + 400);
    assert.strictEqual(entry.lowTs, base + 400);
    assert.strictEqual(entry.reboundTs, base + 900);
    assert.strictEqual(entry.reboundSignature, 'ok-rebound');
    assert.strictEqual(entry.reboundElapsedMs, 500);
    assert(entry.dropPct <= -18);
    assert(entry.reboundPct >= 2);
  }

  {
    const signalTs = base + 300;
    const t = tracker(base, { migration_time: signalTs - 180_000 });
    let signals = 0;
    t.on('flowReversalSignal', () => signals++);
    t.handleSwap(swap(mint, 1, base, 'age-boundary-peak'));
    t.handleSwap(swap(mint, 0.81, base + 100, 'age-boundary-drop'));
    t.handleSwap(swap(mint, 0.83, signalTs, 'age-boundary-rebound'));
    assert.strictEqual(signals, 1, 'an entry signal at exactly 180 seconds must be accepted');
  }

  {
    const t = tracker(base);
    let signals = 0;
    t.on('flowReversalSignal', () => signals++);
    t.handleSwap(swap(mint, 1, base, 'timeout-peak'));
    t.handleSwap(swap(mint, 0.81, base + 100, 'timeout-drop'));
    t.handleSwap(swap(mint, 0.83, base + 1_101, 'timeout-rebound'));
    assert.strictEqual(signals, 0, 'a rebound after 1000ms must be rejected');
    assert.strictEqual(t.states.get(mint).candidate, null);
  }

  {
    const t = tracker(base);
    let signals = 0;
    t.on('flowReversalSignal', () => signals++);
    t.handleSwap(swap(mint, 1, base, 'jump-peak'));
    t.handleSwap(swap(mint, 0.81, base + 100, 'jump-drop'));
    t.handleSwap(swap(mint, 0.86, base + 300, 'jump-rebound'));
    assert.strictEqual(signals, 0, 'the first rebound above 5% must be rejected');
  }

  {
    const t = tracker(base);
    let signals = 0;
    t.on('flowReversalSignal', () => signals++);
    t.handleSwap(swap(mint, 1, base, 'deep-peak'));
    t.handleSwap(swap(mint, 0.77, base + 100, 'deep-drop'));
    t.handleSwap(swap(mint, 0.79, base + 300, 'deep-rebound-into-band'));
    assert.strictEqual(signals, 0);
    assert.strictEqual(t.states.get(mint).candidate, null, 'a >22% drop must not re-arm inside the same episode');
  }

  for (const [name, overrides] of [
    ['low fdv', { fdv: 9_999 }],
    ['high fdv', { fdv: 500_001 }],
    ['entry age over three minutes', { migration_time: base - 181_000 }],
  ]) {
    const t = tracker(base, overrides);
    let signals = 0;
    t.on('flowReversalSignal', () => signals++);
    t.handleSwap(swap(mint, 1, base, `${name}-peak`));
    t.handleSwap(swap(mint, 0.81, base + 100, `${name}-drop`));
    t.handleSwap(swap(mint, 0.83, base + 300, `${name}-rebound`));
    assert.strictEqual(signals, 0, `${name} must fail the monitoring filter`);
    assert.strictEqual(t.states.get(mint).stage, 'ineligible');
  }

  {
    const t = tracker(base, { liquidity: null });
    let signals = 0;
    t.on('flowReversalSignal', () => signals++);
    t.handleSwap(swap(mint, 1, base, 'no-lp-peak'));
    t.handleSwap(swap(mint, 0.81, base + 100, 'no-lp-drop'));
    t.handleSwap(swap(mint, 0.83, base + 300, 'no-lp-rebound'));
    assert.strictEqual(signals, 1, 'missing LP telemetry must not block an entry signal');
  }

  {
    const t = tracker(base);
    t.handleSwap(swap(mint, 1, base, 'panel'));
    const panel = t.getStrategyCandidates(10, base + 100);
    assert.strictEqual(panel.mode, 'DROP_REBOUND_1S');
    assert.strictEqual(panel.thresholds.reboundTimeoutMs, 1_000);
    assert.strictEqual(panel.thresholds.entryMaxTokenAgeMs, 180_000);
    assert.strictEqual(panel.thresholds.maxTokenAgeMs, 300_000);
    assert.strictEqual(panel.thresholds.minLiquidityUsd, 0);
    assert.strictEqual(panel.thresholds.trailingActivatePct, 8);
    assert.strictEqual(panel.thresholds.trailingDrawdownPct, 3);
    assert.strictEqual(panel.thresholds.fastTakeProfitPct, 18);
    assert.strictEqual(panel.thresholds.fastTakeProfitWindowMs, 5_000);
    assert.strictEqual(panel.thresholds.lossCheckAtMs, 6_000);
    assert.strictEqual(panel.thresholds.maxHoldMs, 15_000);
  }

  console.log('Drop/rebound 1s strategy tests: PASS');
}

run();
process.exit(0);
