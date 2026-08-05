'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const PumpGraduationDiscovery = require('../src/core/PumpGraduationDiscovery');
const { config } = require('../src/config');
Module._load = originalLoad;

async function run() {
  assert.strictEqual(config.pumpDiscovery.marketUnavailableRechecks, 1);
  assert.strictEqual(config.pumpDiscovery.marketUnavailableRecheckMs, 3_000);

  let marketCalls = 0;
  let added = null;
  const tokenRegistry = {
    getToken: () => null,
    addToken: async (mint, options) => {
      added = { mint, options };
      return { mint, symbol: 'RECHECK' };
    },
  };
  const discovery = new PumpGraduationDiscovery({
    tokenRegistry,
    settings: {
      marketInitialDelayMs: 0,
      marketRetries: 1,
      marketRetryMs: 1,
      marketUnavailableRechecks: 1,
      marketUnavailableRecheckMs: 250,
      minFdvUsd: 10_000,
      maxFdvUsd: 500_000,
      minLiquidityUsd: 0,
      liquidityRechecks: 0,
    },
    fetchMarket: async () => {
      marketCalls += 1;
      return marketCalls === 1 ? null : { fdv: 20_000, liquidity: null };
    },
    fetchAsset: async () => ({ symbol: 'RECHECK' }),
    onBeforeAdd: async () => [],
  });

  await discovery._screenAndAdd({
    mint: 'MarketRecheckMint11111111111111111111111111',
    poolAddress: 'Pool1111111111111111111111111111111111111',
    migrationTime: Date.now(),
    migrationTimeSource: 'test',
    slot: 123,
    signature: 'test-signature',
    detectionPath: 'test',
  });

  assert.strictEqual(marketCalls, 2, 'one delayed final market lookup must run');
  assert.ok(added, 'candidate must be added when the delayed lookup recovers');
  assert.strictEqual(added.options.meta.fdv, 20_000);
  console.log('Pump discovery market-unavailable recheck test: PASS');
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
