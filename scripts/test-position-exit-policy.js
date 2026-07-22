'use strict';

process.env.RSI_1M_EXIT_ENABLED = 'false';
process.env.RSI_1M_EXIT_THRESHOLD = '80';
process.env.ACTIVITY_FLOW_RSI_1M_MIN_BARS = '8';
process.env.FIXED_STOP_LOSS_PCT = '0';

const assert = require('assert');
const Module = require('module');

// This policy test does not need dotenv; stub it so the test also runs in a
// dependency-light checkout used by CI/static validation.
const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const PositionManager = require('../src/core/PositionManager');
const { config } = require('../src/config');
Module._load = originalLoad;

function position(id, mint, overrides = {}) {
  return {
    positionId: id,
    mint,
    symbol: 'TEST',
    reconciled: true,
    dryRun: false,
    stabilizing: false,
    trailingArmed: false,
    exiting: false,
    status: 'open',
    ...overrides,
  };
}

function managerWith(...positions) {
  const manager = Object.create(PositionManager.prototype);
  manager.positions = new Map();
  manager.byMint = new Map();
  manager._rsiExitSkipLogAt = new Map();
  manager._rsi15sLastByMint = new Map();
  manager._exitCalls = [];
  manager._exit = function mockExit(pos, price, reason) {
    if (pos.exiting) return;
    pos.exiting = true;
    pos.exitReason = reason;
    this._exitCalls.push({ id: pos.positionId, price, reason });
  };

  for (const pos of positions) {
    manager.positions.set(pos.positionId, pos);
    if (!manager.byMint.has(pos.mint)) manager.byMint.set(pos.mint, new Set());
    manager.byMint.get(pos.mint).add(pos.positionId);
  }
  return manager;
}

function rsiSnapshot(live, overrides = {}) {
  return {
    rsi15sLive: live,
    rsi1mLive: live,
    rsi1mClosed: 75,
    rsi1mClosedBars: 8,
    ...overrides,
  };
}

function run() {
  const mint = 'TestMint111111111111111111111111111111111';
  assert.strictEqual(config.strategy.rebuyCooldownMs, 300_000, 'default post-sale cooldown must be 5 minutes');
  assert.strictEqual(config.strategy.trailingActivatePct, 30);
  assert.strictEqual(config.strategy.trailingDrawdownPct, 8);
  assert.strictEqual(config.strategy.takeProfitPct, 0);
  assert.strictEqual(config.strategy.fixedStopLossPct, 0);
  assert.strictEqual(config.strategy.maxHoldMs, 300_000);

  {
    const manager = managerWith();
    const price = manager._priceFromState({
      poolBaseAmount: { toString: () => '100000000000000' },
      poolQuoteAmount: { toString: () => '135800000000' },
      pool: { virtualQuoteReserves: { toString: () => '17900000000' } },
    }, 6);
    assert(Math.abs(price - 1.537e-6) < 1e-15, 'position polling must include virtual reserves');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1,
      openedAt: now,
      reconciledAt: now,
      stabilizing: true,
      _stabilizeSamples: [],
    });
    const second = position('p2', mint, { entryPrice: 1, highWaterMark: 1 });
    const manager = managerWith(first, second);
    manager._checkExit('p1', 0.79);
    assert.strictEqual(manager._exitCalls.length, 0, 'fixed stop is not part of the RSI exit policy');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1,
      openedAt: now,
      reconciledAt: now,
      stabilizing: true,
      _stabilizeSamples: [],
    });
    const manager = managerWith(first);
    manager._checkExit('p1', 0.81);
    assert.strictEqual(manager._exitCalls.length, 0, 'fixed stop must not trigger above -20%');
  }

  {
    const manager = managerWith(position('p1', mint), position('p2', mint));
    assert.strictEqual(manager.handleRsiForExit(mint, 1, rsiSnapshot(80)), false, 'RSI=80 is not >80');
    assert.strictEqual(manager.handleRsiForExit(mint, 1, rsiSnapshot(81)), true);
    assert.deepStrictEqual(manager._exitCalls.map((x) => x.id), ['p1', 'p2']);
    assert(manager._exitCalls.every((x) => x.reason === 'RSI_15S_OVERBOUGHT'));
  }

  {
    const manager = managerWith(position('p1', mint));
    assert.strictEqual(manager.handleRsiForExit(mint, 1, rsiSnapshot(75)), false);
    assert.strictEqual(manager.handleRsiForExit(mint, 1, rsiSnapshot(70)), false, 'touching 70 is not below 70');
    assert.strictEqual(manager.handleRsiForExit(mint, 1, rsiSnapshot(69.9)), true);
    assert.strictEqual(manager._exitCalls[0].reason, 'RSI_15S_CROSS_DOWN');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1.3,
      highWaterMarkTs: now,
      openedAt: now,
      reconciledAt: now,
    });
    const manager = managerWith(first);
    manager._checkExit('p1', 1.3);
    assert.strictEqual(first.trailingArmed, true, '+30% must arm trailing before RSI is evaluated');
    assert.strictEqual(manager.handleRsiForExit(mint, 1.3, rsiSnapshot(81)), false);
    assert.strictEqual(manager.handleRsiForExit(mint, 1.3, rsiSnapshot(75)), false);
    assert.strictEqual(manager.handleRsiForExit(mint, 1.3, rsiSnapshot(70)), false);
    assert.strictEqual(manager.handleRsiForExit(mint, 1.3, rsiSnapshot(69.9)), false);
    assert.strictEqual(manager._exitCalls.length, 0, 'armed trailing must block both RSI exits');
  }

  {
    const first = position('p1', mint, { trailingArmed: true });
    const second = position('p2', mint, { trailingArmed: false });
    const manager = managerWith(first, second);
    assert.strictEqual(manager.handleRsiForExit(mint, 1, rsiSnapshot(81)), false);
    assert.strictEqual(manager._exitCalls.length, 0, 'one armed position must protect the same-mint group');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1.3,
      openedAt: now - 10_000,
      reconciledAt: now - 10_000,
      trailingArmed: true,
      _armedHwm: 1.3,
      _armedHwmTs: now - 5_000,
    });
    const manager = managerWith(first);
    manager._checkExit('p1', 1.19);
    assert.strictEqual(manager._exitCalls.length, 1, '8% drawdown after +30% trailing arm should sell');
    assert.strictEqual(manager._exitCalls[0].reason, 'TRAILING_STOP');
  }

  {
    const first = position('p1', mint);
    const second = position('p2', mint);
    const manager = managerWith(first, second);
    manager._exitForCondition(second, 0.8, 'TRAILING_STOP');
    assert.deepStrictEqual(manager._exitCalls.map((x) => x.id), ['p1', 'p2']);
    assert(manager._exitCalls.every((x) => x.reason === 'TRAILING_STOP'));
  }

  {
    const first = position('p1', mint, {
      exiting: true,
      openedAt: 1,
      entryPrice: 1,
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 0.7 };
    assert.strictEqual(manager.canAddOn(mint).reason, 'addon_removed');
  }

  console.log('Position exit policy tests: PASS');
}

run();
process.exit(0);
