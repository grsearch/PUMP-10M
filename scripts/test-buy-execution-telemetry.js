'use strict';

const assert = require('assert');
const TradeLogger = require('../src/data/TradeLogger');

function createDatabase() {
  try {
    const Database = require('better-sqlite3');
    return new Database(':memory:');
  } catch (_) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.pragma = (query) => db.prepare(`PRAGMA ${query}`).all();
    return db;
  }
}

const db = createDatabase();
db.exec(`
  CREATE TABLE swap_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    mint TEXT NOT NULL,
    symbol TEXT,
    signer TEXT,
    side TEXT NOT NULL,
    sol_volume REAL,
    price REAL,
    price_before REAL,
    price_change_pct REAL,
    slot INTEGER,
    signature TEXT,
    pool_address TEXT,
    pool_quote_after REAL
  );
`);

const logger = new TradeLogger(db);
const submitAcceptedAt = 1_800_000_000_120;
logger.logBotLatencyEvent({
  ts: submitAcceptedAt,
  mint: 'mint',
  symbol: 'TEST',
  signature: 'signature',
  phase: 'buy',
  candidateTs: 1_800_000_000_000,
  candidateSlot: 100,
  reboundTs: 1_800_000_000_050,
  reboundSlot: 100,
  signalReceivedAt: 1_800_000_000_060,
  submitStartedAt: 1_800_000_000_100,
  submitAcceptedAt,
  submittedSlot: 100,
  submissionChannel: 'Sender',
  computeUnitLimit: 400_000,
  priorityFeeLamports: 3_000_000,
  jitoTipLamports: 1_000_000,
  stateSource: 'cache',
  cacheAgeBeforeMs: 75,
  cacheAgeAtBuildMs: 82,
  latencyCandidateToReboundMs: 50,
  latencyReboundToSubmitMs: 70,
  latencySubmitAcceptedMs: 20,
});

logger.updateBotLatencyLanding({
  signature: 'signature',
  landedObservedAt: 1_800_000_000_420,
  landedSlot: 102,
});
logger.updateBotLatencyLanding({
  signature: 'signature',
  landedObservedAt: 1_800_000_000_620,
  landedBlockTimeMs: 1_800_000_000_000,
  landedSlot: 102,
  computeUnitsConsumed: 215_000,
  computeUnitLimit: 250_000,
  chainSuccess: true,
});

const row = db.prepare("SELECT * FROM bot_latency_events WHERE signature = 'signature'").get();
assert.strictEqual(row.submission_channel, 'Sender');
assert.strictEqual(row.candidate_slot, 100);
assert.strictEqual(row.landed_slot, 102);
assert.strictEqual(row.compute_unit_limit, 400_000, 'landing must preserve the limit used at build');
assert.strictEqual(row.compute_units_consumed, 215_000);
assert.strictEqual(row.chain_success, 1);
assert.strictEqual(row.landed_observed_at, 1_800_000_000_420);
assert.strictEqual(row.latency_landed_ms, 300);
assert.strictEqual(row.latency_confirm_ms, 360);
assert.deepStrictEqual(logger.getRecentBuyComputeUnitSamples(10), [215_000]);

console.log('BUY execution telemetry tests: PASS');
