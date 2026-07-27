'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const PositionManager = require('../src/core/PositionManager');
const SignalEngine = require('../src/core/SignalEngine');
const { config } = require('../src/config');
Module._load = originalLoad;

function position(id, mint, overrides = {}) {
  const now = Date.now();
  return {
    positionId: id,
    mint,
    symbol: 'TEST',
    entryPrice: 1,
    entrySol: 0.1,
    tokenAmount: 100_000,
    openedAt: now - 10_000,
    reconciledAt: now - 10_000,
    reconciled: true,
    dryRun: false,
    stabilizing: false,
    trailingArmed: false,
    highWaterMark: 1,
    highWaterMarkTs: now - 10_000,
    exiting: false,
    status: 'open',
    isAddOn: false,
    ...overrides,
  };
}

function managerWith(tokenInfo, ...positions) {
  const manager = Object.create(PositionManager.prototype);
  manager.positions = new Map();
  manager.byMint = new Map();
  manager._flowExitEvents = new Map();
  manager._rsi1sLastLiveByMint = new Map();
  manager._exitCalls = [];
  manager.priceTracker = { getPrice: () => 1 };
  manager.tokenRegistry = { getToken: () => tokenInfo };
  manager._fillPreVolFallback = () => {};
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

function run() {
  const mint = 'TestMint111111111111111111111111111111111';
  const healthyToken = {
    fdv: 100_000,
    migration_time: Date.now() - 10 * 60_000,
  };

  assert.strictEqual(config.strategy.trailingActivatePct, 10);
  assert.strictEqual(config.strategy.trailingDrawdownPct, 5);
  assert.strictEqual(config.strategy.trailingMinHwmAgeMs, 0);
  assert.strictEqual(config.strategy.fixedStopLossPct, 0);
  assert.strictEqual(config.strategy.maxHoldMs, 30_000);
  assert.strictEqual(config.strategy.fdvExitThresholdUsd, 0);
  assert.strictEqual(config.strategy.ageExitMs, 15 * 60_000);
  assert.strictEqual(typeof PositionManager.prototype.handleRsiForExit, 'function');

  {
    const unarmed = position('p1', mint);
    const armed = position('p2', mint, {
      isAddOn: true,
      entryPrice: 0.85,
      trailingArmed: true,
    });
    const manager = managerWith(healthyToken, unarmed, armed);
    const exited = manager.handleRsiForExit(mint, 1.01, {
      rsi1sClosedBucketTs: 1_000,
      rsi1sPreviousClosed: 65,
      rsi1sClosed: 65,
      rsi1sLive: 81,
    });
    assert.strictEqual(exited, true);
    assert.deepStrictEqual(manager._exitCalls.map((row) => row.id), ['p1']);
    assert.strictEqual(manager._exitCalls[0].reason, 'RSI_1S_OVERBOUGHT');
    assert.strictEqual(armed.exiting, false, 'trailing-armed leg must ignore RSI exits');

    manager.handleRsiForExit(mint, 1.01, {
      rsi1sClosedBucketTs: 1_000,
      rsi1sPreviousClosed: 65,
      rsi1sClosed: 65,
      rsi1sLive: 81,
    });
    assert.strictEqual(manager._exitCalls.length, 1, 'an already exiting leg must not enqueue a duplicate sell');
  }

  {
    const leg = position('p1', mint);
    const manager = managerWith(healthyToken, leg);
    manager._checkExit('p1', 1.1, { source: 'trailing_arm_priority' });
    assert.strictEqual(leg.trailingArmed, true, 'one trusted +10% tick must update HWM and arm trailing');

    const exited = manager.handleRsiForExit(mint, 1.1, {
      rsi1sClosedBucketTs: 1_500,
      rsi1sPreviousClosed: 75,
      rsi1sClosed: 75,
      rsi1sLive: 81,
    });
    assert.strictEqual(exited, false);
    assert.strictEqual(manager._exitCalls.length, 0, 'RSI must not exit after trailing arms first');
  }

  {
    const manager = managerWith(healthyToken, position('p1', mint));
    manager.handleRsiForExit(mint, 1.01, {
      rsi1sClosedBucketTs: 2_000,
      rsi1sClosed: 72,
      rsi1sLive: 72,
    });
    assert.strictEqual(manager._exitCalls.length, 0);
    manager.handleRsiForExit(mint, 1.01, {
      rsi1sClosedBucketTs: 2_000,
      rsi1sClosed: 72,
      rsi1sLive: 69,
    });
    assert.strictEqual(manager._exitCalls.length, 1);
    assert.strictEqual(manager._exitCalls[0].reason, 'RSI_1S_CROSS_DOWN');
  }

  {
    const leg = position('p1', mint);
    const manager = managerWith(healthyToken, leg);
    manager._checkExit('p1', 1.27, { source: 'volatile_single_tick_high' });
    assert.strictEqual(leg.highWaterMark, 1.27, 'a one-tick volatile high must immediately become HWM');
    assert.strictEqual(leg.trailingArmed, true);
    manager._checkExit('p1', 1.2, { source: 'immediate_trailing_drawdown' });
    assert.strictEqual(manager._exitCalls.length, 1, '5% drawdown must not be hidden behind an age delay');
    assert.strictEqual(manager._exitCalls[0].reason, 'TRAILING_STOP');
  }

  {
    const leg = position('p1', mint);
    const manager = managerWith(healthyToken, leg);
    manager._checkExit('p1', 0.5, { source: 'fixed_stop_disabled' });
    assert.strictEqual(manager._exitCalls.length, 0, 'fixed stop must remain disabled at any loss');
  }

  {
    const manager = managerWith(healthyToken);
    const price = manager._priceFromState({
      poolBaseAmount: { toString: () => '100000000000000' },
      poolQuoteAmount: { toString: () => '135800000000' },
      pool: { virtualQuoteReserves: { toString: () => '17900000000' } },
    }, 6);
    assert(Math.abs(price - 1.537e-6) < 1e-15, 'position polling must include virtual reserves');
  }

  {
    const first = position('p1', mint, {
      trailingArmed: true,
      highWaterMark: 1.5,
      highWaterMarkTs: Date.now() - 5_000,
      _armedHwm: 1.5,
      _armedHwmTs: Date.now() - 5_000,
    });
    const second = position('p2', mint, { isAddOn: true, entryPrice: 0.85 });
    const manager = managerWith(healthyToken, first, second);
    manager._checkExit('p1', 1.34);
    assert.deepStrictEqual(manager._exitCalls.map((row) => row.id), ['p1']);
    assert.strictEqual(manager._exitCalls[0].reason, 'TRAILING_STOP');
    assert.strictEqual(second.exiting, false, 'one leg exit must not close the other leg');
  }

  {
    const initial = position('p1', mint);
    const manager = managerWith(healthyToken, initial);
    assert.strictEqual(manager.canAddOn(mint, 0.8501).allowed, false);
    const allowed = manager.canAddOn(mint, 0.85);
    assert.strictEqual(allowed.allowed, true);
    assert.strictEqual(allowed.initialPositionId, 'p1');
    assert(Math.abs(allowed.dropPct - 15) < 1e-9);
  }

  {
    const engine = Object.create(SignalEngine.prototype);
    engine.tradeLogger = { countSuccessfulBuysByMint: () => 999 };
    engine.positionManager = {
      openPositionCountByMint: () => 1,
      canAddOn: (_mint, price) => ({
        allowed: price <= 0.85,
        dropPct: 15,
        initialPositionId: 'p1',
      }),
    };
    const addOn = engine._getMintBuyAllowance(mint, 0.85);
    assert.strictEqual(addOn.allowed, true);
    assert.strictEqual(addOn.isAddOn, true);
    assert.strictEqual(engine._getMintBuyAllowance(mint, 0.8501).allowed, false);

    engine.positionManager.openPositionCountByMint = () => 2;
    assert.strictEqual(
      engine._getMintBuyAllowance(mint, 0.5).allowed,
      false,
      'two concurrently open legs must block a third leg',
    );

    engine.positionManager.openPositionCountByMint = () => 0;
    const reentry = engine._getMintBuyAllowance(mint, 0.5);
    assert.strictEqual(reentry.allowed, true);
    assert.strictEqual(reentry.isAddOn, false);
    assert.strictEqual(
      engine.tradeLogger.countSuccessfulBuysByMint(),
      999,
      'historical buys may exist but must not block a fresh re-entry after full close',
    );
  }

  {
    const initial = position('p1', mint);
    const addOn = position('p2', mint, { isAddOn: true, entryPrice: 0.85 });
    const manager = managerWith(healthyToken, initial, addOn);
    assert.strictEqual(manager.canAddOn(mint, 0.5).reason, 'max_two_buys_reached');
  }

  {
    const first = position('p1', mint);
    const second = position('p2', mint, { isAddOn: true, entryPrice: 0.85 });
    const manager = managerWith({ ...healthyToken, fdv: 19_999 }, first, second);
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 0, 'FDV below $20k must no longer force an exit');
    assert.strictEqual(first.removeFromMonitoringAfterClose, undefined);
    assert.strictEqual(second.removeFromMonitoringAfterClose, undefined);
  }

  {
    const oldToken = {
      fdv: 100_000,
      migration_time: Date.now() - 15 * 60_000,
    };
    const manager = managerWith(oldToken, position('p1', mint));
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 1);
    assert.strictEqual(manager._exitCalls[0].reason, 'AGE_15M');
  }

  {
    const liveFdvPosition = position('p1', mint, {
      entryPrice: 0.000001,
      highWaterMark: 0.000001,
    });
    const manager = managerWith(healthyToken, liveFdvPosition);
    manager._checkExit('p1', 0.0000002, { source: 'test_live_fdv' });
    assert.strictEqual(
      manager._exitCalls.length,
      0,
      'live effective price must not trigger an FDV exit when the rule is disabled',
    );
    assert.strictEqual(liveFdvPosition.removeFromMonitoringAfterClose, undefined);
  }

  {
    const timedOut = position('p1', mint, {
      openedAt: Date.now() - 30_000,
      reconciledAt: Date.now() - 29_000,
    });
    const recent = position('p2', mint, {
      isAddOn: true,
      openedAt: Date.now() - 29_000,
      reconciledAt: Date.now() - 29_000,
    });
    const manager = managerWith(healthyToken, timedOut, recent);
    manager._tick();
    assert.deepStrictEqual(manager._exitCalls.map((row) => row.id), ['p1']);
    assert.strictEqual(manager._exitCalls[0].reason, 'HOLD_TIMEOUT_30S');
    assert.strictEqual(recent.exiting, false, 'each leg must use its own 30-second holding timer');
    assert.strictEqual(timedOut.removeFromMonitoringAfterClose, undefined);
  }

  {
    const manager = managerWith(healthyToken, position('p1', mint));
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 0, 'healthy token must not be force-sold');
  }

  console.log('Position exit policy tests: PASS');
}

run();
process.exit(0);
