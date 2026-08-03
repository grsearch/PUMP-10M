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
    entrySol: 0.2,
    tokenAmount: 100_000,
    openedAt: now - 5_000,
    reconciledAt: now - 5_000,
    reconciled: true,
    dryRun: false,
    stabilizing: false,
    trailingArmed: false,
    highWaterMark: 1,
    highWaterMarkTs: now - 5_000,
    noRecoveryHighWaterMark: 1,
    noRecoveryEvaluated: false,
    lossCheckEvaluated: false,
    exiting: false,
    status: 'open',
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
  manager.tradeLogger = { stmts: {} };
  manager._fillPreVolFallback = () => {};
  manager._exit = function mockExit(pos, price, reason) {
    if (pos.exiting) return;
    pos.exiting = true;
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
  const token = { fdv: 100_000, migration_time: Date.now() - 60_000 };

  assert.strictEqual(config.strategy.trailingActivatePct, 8);
  assert.strictEqual(config.strategy.trailingDrawdownPct, 3);
  assert.strictEqual(config.strategy.fastTakeProfitPct, 8);
  assert.strictEqual(config.strategy.fastTakeProfitWindowMs, 5_000);
  assert.strictEqual(config.strategy.lossCheckAtMs, 6_000);
  assert.strictEqual(config.strategy.trailingMinHwmAgeMs, 0);
  assert.strictEqual(config.strategy.maxHoldMs, 15_000);
  assert.strictEqual(config.strategy.takeProfitPct, 0);
  assert.strictEqual(config.strategy.fixedStopLossPct, 0);
  assert.strictEqual(config.strategy.buyMaxPriceDeviationPct, 3);
  assert.strictEqual(config.strategy.emergencyStopLossPct, 0);
  assert.strictEqual(config.strategy.rsi1sExitEnabled, false);
  assert.strictEqual(config.strategy.noRecoveryExitEnabled, false);
  assert.strictEqual(config.strategy.flowReversalExitEnabled, false);
  assert.strictEqual(config.strategy.fdvExitThresholdUsd, 0);
  assert.strictEqual(config.strategy.ageExitMs, 0);

  {
    const leg = position('p1', mint, { openedAt: Date.now() - 5_100 });
    const manager = managerWith(token, leg);
    manager._checkExit('p1', 1.079, { source: 'below_arm' });
    assert.strictEqual(leg.trailingArmed, false);
    manager._checkExit('p1', 1.08, { source: 'arm' });
    assert.strictEqual(leg.trailingArmed, true, '+8% must arm trailing');
    manager._checkExit('p1', 1.048, { source: 'drawdown' });
    assert.strictEqual(manager._exitCalls.length, 0, 'drawdown below 3% must remain open');
    manager._checkExit('p1', 1.047, { source: 'drawdown' });
    assert.strictEqual(manager._exitCalls[0].reason, 'TRAILING_STOP');
  }

  {
    const leg = position('p1', mint, { openedAt: Date.now() - 4_000 });
    const manager = managerWith(token, leg);
    manager._checkExit('p1', 1.08, { source: 'fast_profit' });
    assert.strictEqual(manager._exitCalls.length, 1);
    assert.strictEqual(manager._exitCalls[0].reason, 'FAST_TP_5S');
    assert.strictEqual(leg.trailingArmed, false, 'fast TP must sell instead of arming trailing');
  }

  {
    const losing = position('p1', mint, {
      openedAt: Date.now() - 6_100,
      _lastTickPrice: 0.99,
      _lastTickAt: Date.now(),
    });
    const manager = managerWith(token, losing);
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 1);
    assert.strictEqual(manager._exitCalls[0].reason, 'LOSS_CHECK_6S');
    assert.strictEqual(losing.lossCheckEvaluated, true);
  }

  {
    const profitable = position('p1', mint, {
      openedAt: Date.now() - 6_100,
      _lastTickPrice: 1.01,
      _lastTickAt: Date.now(),
    });
    const manager = managerWith(token, profitable);
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 0);
    assert.strictEqual(profitable.lossCheckEvaluated, true);
    profitable._lastTickPrice = 0.99;
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 0, 'six-second loss check must run only once');
  }

  {
    const stale = position('p1', mint, {
      openedAt: Date.now() - 6_100,
      _lastTickPrice: 0.99,
      _lastTickAt: Date.now() - 2_000,
    });
    const manager = managerWith(token, stale);
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 0, 'a stale price must not decide the sixth-second checkpoint');
    assert.strictEqual(stale.lossCheckEvaluated, false);
  }

  {
    const leg = position('p1', mint, { openedAt: Date.now() - 1_000 });
    const manager = managerWith(token, leg);
    manager._checkExit('p1', 0.5, { source: 'fixed_stop_disabled' });
    assert.strictEqual(
      manager._exitCalls.length,
      0,
      'fixed stop must remain disabled even when a stale server env is present',
    );
  }

  {
    const leg = position('p1', mint);
    const manager = managerWith(token, leg);
    manager._checkExit('p1', 0.95, { source: 'other_legacy_stops_disabled' });
    assert.strictEqual(manager._exitCalls.length, 0, 'other legacy price exits must remain disabled');
    assert.strictEqual(
      manager.handleRsiForExit(mint, 1.1, { rsi1sClosed: 85, rsi1sLive: 85 }),
      false,
      'RSI exits must be disabled',
    );
  }

  {
    const timedOut = position('p1', mint, { openedAt: Date.now() - 15_100 });
    const recent = position('p2', 'OtherMint', {
      openedAt: Date.now() - 14_900,
      lossCheckEvaluated: true,
    });
    const manager = managerWith(token, timedOut, recent);
    manager._tick();
    assert.deepStrictEqual(manager._exitCalls.map((row) => row.id), ['p1']);
    assert.strictEqual(manager._exitCalls[0].reason, 'HOLD_TIMEOUT_15S');
    assert.strictEqual(recent.exiting, false);
  }

  {
    const manager = managerWith({ ...token, fdv: 1_000 }, position('p1', mint));
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 0, 'FDV is a watchlist removal, not a position exit');
  }

  {
    const manager = managerWith(token);
    const price = manager._priceFromState({
      poolBaseAmount: { toString: () => '100000000000000' },
      poolQuoteAmount: { toString: () => '135800000000' },
      pool: { virtualQuoteReserves: { toString: () => '17900000000' } },
    }, 6);
    assert(Math.abs(price - 1.537e-6) < 1e-15, 'polling price must include virtual reserves');
  }

  {
    const engine = Object.create(SignalEngine.prototype);
    engine.tradeLogger = { countSuccessfulBuysByMint: () => 9 };
    engine.positionManager = { openPositionCountByMint: () => 0 };
    assert.strictEqual(engine._getMintBuyAllowance(mint, 1).allowed, true, 'closed mint may re-enter');
    engine.positionManager.openPositionCountByMint = () => 1;
    assert.strictEqual(engine._getMintBuyAllowance(mint, 1).allowed, false, 'same-mint legs must not overlap');
  }

  console.log('Position exit policy tests: PASS');
}

run();
process.exit(0);
