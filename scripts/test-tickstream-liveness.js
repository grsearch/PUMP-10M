'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === '@triton-one/yellowstone-grpc') {
    return {
      default: class StubYellowstoneClient {},
      CommitmentLevel: { PROCESSED: 0 },
      SubscribeRequest: { create: (value) => value },
      SubscribeRequestFilterTransactions: { create: (value) => value },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const TickStream = require('../src/core/TickStream');
const { RegionStream } = TickStream;
const AlertChecker = require('../src/monitor/AlertChecker');
const { getMonitor } = require('../src/monitor/HealthMonitor');
Module._load = originalLoad;

const MINT = 'TickStreamLiveness1111111111111111111111111';

async function testColdStartLifecycle() {
  const calls = {
    start: 0,
    rebuild: 0,
    slotSubscriber: 0,
    shredStream: 0,
    worker: 0,
  };
  const fakeRegion = {
    label: 'LS-TEST',
    shouldRun: false,
    async start(mints) {
      calls.start++;
      this.shouldRun = true;
      this.mints = [...mints];
    },
    async rebuild(mints) {
      calls.rebuild++;
      this.mints = [...mints];
    },
  };
  const tickStream = Object.create(TickStream.prototype);
  tickStream.shouldRun = false;
  tickStream.watchedMints = new Set();
  tickStream.regions = [fakeRegion];
  tickStream._startSlotSubscriber = () => { calls.slotSubscriber++; };
  tickStream._startShredStream = () => { calls.shredStream++; };
  tickStream._startWorker = () => { calls.worker++; };
  tickStream._cleanupSigFirstRegion = () => {};
  tickStream._printSsLeadStats = () => {};
  tickStream._latestSlotFromSlotUpdate = 0;
  tickStream._rebuildInProgress = false;
  tickStream._rebuildQueued = false;

  await tickStream.start([]);
  assert.strictEqual(calls.start, 1, 'regions must be armed even when startup watchlist is empty');
  assert.strictEqual(fakeRegion.shouldRun, true);
  assert.strictEqual(calls.slotSubscriber, 1);
  assert.strictEqual(calls.shredStream, 1);
  assert.strictEqual(calls.worker, 1);

  tickStream.watchedMints = new Set([MINT]);
  await tickStream._performRebuild();
  assert.strictEqual(calls.rebuild, 1);
  assert.deepStrictEqual(fakeRegion.mints, [MINT]);

  clearInterval(tickStream._ssLeadStatsTimer);
  clearInterval(tickStream._laggyReconnectTimer);
  tickStream.shouldRun = false;
}

async function testRegionIdleLiveness() {
  const region = new RegionStream({
    endpoint: 'https://example.invalid',
    token: 'test',
    label: 'LS-TEST',
    onTx() {},
  });
  region.shouldRun = true;
  region._currentMints = [MINT];
  region.connected = true;
  region._connectedAt = Date.now();
  let written = null;
  region.stream = {
    write(request, callback) {
      written = request;
      callback(null);
    },
  };

  await region._sendSubscribeRequest();
  assert(written.transactions.pumpAmmTrades, 'v1 Pump AMM filter must be present');
  assert(written.transactions.pumpAmmV2Trades, 'v2 Pump AMM filter must be present');

  await region._sendKeepalivePing();
  assert(written?.ping?.id > 0, 'keepalive must use the same subscription stream');
  assert.deepStrictEqual(written.transactions, {});

  const pongAt = Date.now();
  region._handleMessage({ pong: { id: written.ping.id } });
  assert(region._lastPongAt >= pongAt);
  const idleHealth = region.getHealth(Date.now());
  assert.strictEqual(idleHealth.healthy, true);
  assert.strictEqual(idleHealth.lastTxAgeMs, null, 'zero matching trades must still be healthy');

  const staleNow = Date.now();
  region._connectedAt = staleNow - 100_000;
  region._lastMessageAt = staleNow - 100_000;
  region._lastPongAt = staleNow - 100_000;
  assert.strictEqual(region.getHealth(staleNow).healthy, false);
}

async function testIdleRegionCanConnectLater() {
  const region = new RegionStream({
    endpoint: 'https://example.invalid',
    token: 'test',
    label: 'LS-LATE',
    onTx() {},
  });
  let connects = 0;
  region._connect = async () => {
    connects++;
    region.connected = true;
  };
  region._closeStream = async () => {
    region.connected = false;
  };

  await region.start([]);
  assert.strictEqual(region.shouldRun, true);
  assert.strictEqual(connects, 0);
  await region.rebuild([MINT]);
  assert.strictEqual(connects, 1, 'first post-start mint must connect an initially idle region');
}

function makeAlertMonitor() {
  return {
    cleared: [],
    fired: [],
    counters: new Map(),
    clearAlert(name) {
      this.cleared.push(name);
    },
    fireAlert(name, severity, message, context) {
      this.fired.push({ name, severity, message, context });
    },
    set(name, value) {
      this.counters.set(name, value);
    },
    inc(name, value = 1) {
      this.counters.set(name, (this.counters.get(name) || 0) + value);
    },
  };
}

function testAlertUsesStreamHealthNotTraffic() {
  const monitor = makeAlertMonitor();
  const healthyRegion = {
    label: 'LS-TEST',
    getHealth: () => ({
      label: 'LS-TEST',
      expected: true,
      connected: true,
      healthy: true,
      activityAgeMs: 1_000,
      lastPongAgeMs: 1_000,
      lastTxAgeMs: null,
      watchedMints: 1,
    }),
  };
  const checker = new AlertChecker({
    monitor,
    tickStream: { regions: [healthyRegion] },
    tokenRegistry: { getActiveMintSet: () => new Set([MINT]) },
    config: {},
  });
  checker._checkTickStream();
  assert(monitor.cleared.includes('tickstream.no_traffic'));
  assert(monitor.cleared.includes('tickstream.stream_unhealthy'));
  assert.strictEqual(monitor.fired.length, 0, 'idle but healthy stream must not alert');

  let reconnects = 0;
  const unhealthyRegion = {
    label: 'LS-TEST',
    reconnectAttempts: 3,
    getHealth: () => ({
      label: 'LS-TEST',
      expected: true,
      connected: false,
      healthy: false,
      activityAgeMs: 100_000,
      lastPongAgeMs: 100_000,
      lastTxAgeMs: null,
      watchedMints: 1,
    }),
    _scheduleReconnect() {
      reconnects++;
    },
  };
  checker.tickStream.regions = [unhealthyRegion];
  checker._checkTickStream();
  assert.strictEqual(monitor.fired.at(-1).name, 'tickstream.stream_unhealthy');
  assert.strictEqual(reconnects, 1, 'genuinely unhealthy stream must self-heal');
}

async function run() {
  await testColdStartLifecycle();
  await testRegionIdleLiveness();
  await testIdleRegionCanConnectLater();
  testAlertUsesStreamHealthNotTraffic();
  getMonitor().stop();
  console.log('TickStream cold-start and liveness tests: PASS');
}

run().catch((err) => {
  getMonitor().stop();
  console.error(err);
  process.exitCode = 1;
});
