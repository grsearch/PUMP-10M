'use strict';

const assert = require('assert');
const PoolStateCache = require('../src/core/PoolStateCache');

async function run() {
  const monitored = [
    { mint: 'mint-a', poolAddress: 'pool-a' },
    { mint: 'mint-b', poolAddress: 'pool-b' },
    { mint: 'mint-c', poolAddress: 'pool-c' },
  ];
  const cache = new PoolStateCache({
    onlineSdk: {},
    user: {},
    getMintList: () => monitored.slice(),
  });
  cache.prewarmBatchSize = 2;
  cache.prewarmBatchDelayMs = 0;
  cache.timer = {};
  assert.strictEqual(cache.positionRefreshMs, 500);
  assert.strictEqual(cache.signalRefreshMs, 2000);
  assert.strictEqual(cache.baseRefreshMs, 60000);

  const fetches = [];
  cache._fetchPoolState = async (poolAddress) => {
    fetches.push(poolAddress);
    return {
      poolAddress,
      poolBaseAmount: { toString: () => '1000000' },
      poolQuoteAmount: { toString: () => '1000000000' },
      pool: { virtualQuoteReserves: { toString: () => '15000000000' } },
    };
  };

  await cache._prewarmMonitored();
  assert.strictEqual(cache.monitoredMints.size, 3, 'getMintList must seed the foundation layer');
  assert.strictEqual(cache.cache.size, 3, 'startup prewarm must load every monitored pool');
  assert.deepStrictEqual(new Set(fetches), new Set(['pool-a', 'pool-b', 'pool-c']));

  cache.hotMints.clear();
  cache.hotMints.set('removed-mint', { poolAddress: 'orphan-pool', isPosition: false });
  cache.cache.set('orphan-pool', { state: { orphan: true }, fetchedAt: Date.now() });
  await cache._refreshAll();
  assert(cache.cache.has('pool-a'), 'hotMints=0 must retain active monitored pool cache');
  assert(cache.cache.has('pool-b'), 'foundation cache must survive without a signal');
  assert(!cache.cache.has('orphan-pool'), 'only pools removed from monitoring may be evicted');
  assert(!cache.hotMints.has('removed-mint'), 'removed non-position signal tiers must be dropped');

  monitored.push({ mint: 'mint-d', poolAddress: 'pool-d' });
  cache._syncMonitoredTargets({ prewarmNew: true });
  await Promise.all(Array.from(cache._inflightRefreshes.values()));
  assert(cache.cache.has('pool-d'), 'new monitored mint must trigger immediate prewarm');

  fetches.length = 0;
  cache.hotMints.set('mint-a', { poolAddress: 'pool-a', isPosition: false });
  cache.hotMints.set('mint-b', { poolAddress: 'pool-b', isPosition: true });
  await cache._refreshAll();
  assert(fetches.includes('pool-a'), 'signal tier must continue refreshing');
  assert(fetches.includes('pool-b'), 'position tier must continue refreshing');
  assert(
    fetches.some((pool) => pool === 'pool-c' || pool === 'pool-d'),
    'base tier must refresh alongside hot tiers',
  );
  cache.hotMints.clear();

  let dedupFetches = 0;
  let releaseFetch;
  cache._fetchPoolState = async (poolAddress) => {
    dedupFetches += 1;
    return new Promise((resolve) => {
      releaseFetch = () => resolve({
        poolAddress,
        poolBaseAmount: { toString: () => '1000000' },
        poolQuoteAmount: { toString: () => '1000000000' },
        pool: { virtualQuoteReserves: { toString: () => '15000000000' } },
      });
    });
  };
  const first = cache.refreshOne('pool-dedup', { force: true });
  const second = cache.refreshOne('pool-dedup', { force: true });
  await Promise.resolve();
  assert.strictEqual(dedupFetches, 1, 'concurrent refreshes for one pool must be deduplicated');
  releaseFetch();
  const [firstState, secondState] = await Promise.all([first, second]);
  assert.strictEqual(firstState, secondState, 'deduplicated callers must share the same state');

  cache.stop();
  console.log('PoolStateCache foundation/prewarm tests: PASS');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
