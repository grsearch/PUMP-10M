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

  assert.strictEqual(config.strategy.trailingActivatePct, 50);
  assert.strictEqual(config.strategy.trailingDrawdownPct, 10);
  assert.strictEqual(config.strategy.fixedStopLossPct, 0);
  assert.strictEqual(Object.hasOwn(config.strategy, 'maxHoldMs'), false);
  assert.strictEqual(config.strategy.fdvExitThresholdUsd, 20_000);
  assert.strictEqual(config.strategy.ageExitMs, 15 * 60_000);
  assert.strictEqual(PositionManager.prototype.handleRsiForExit, undefined);

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
    engine.tradeLogger = { countSuccessfulBuysByMint: () => 1 };
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

    engine.tradeLogger.countSuccessfulBuysByMint = () => 2;
    assert.strictEqual(
      engine._getMintBuyAllowance(mint, 0.5).allowed,
      false,
      'historical successful buys must enforce the lifetime two-buy cap',
    );

    engine.tradeLogger.countSuccessfulBuysByMint = () => 1;
    engine.positionManager.openPositionCountByMint = () => 0;
    assert.strictEqual(
      engine._getMintBuyAllowance(mint, 0.5).allowed,
      false,
      'a closed first leg cannot be replaced by a later second initial buy',
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
    assert.deepStrictEqual(manager._exitCalls.map((row) => row.id), ['p1', 'p2']);
    assert(manager._exitCalls.every((row) => row.reason === 'FDV_BELOW_20000'));
    assert.strictEqual(first.removeFromMonitoringAfterClose, true);
    assert.strictEqual(second.removeFromMonitoringAfterClose, true);
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
      1,
      'live effective price must trigger FDV exit without waiting for market refresh',
    );
    assert.strictEqual(manager._exitCalls[0].reason, 'FDV_BELOW_20000');
    assert.strictEqual(liveFdvPosition.removeFromMonitoringAfterClose, true);
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
