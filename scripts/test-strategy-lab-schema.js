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

function run() {
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
  const snapshotColumns = db.pragma('table_info(token_snapshots)').map((row) => row.name);
  const swapColumns = new Set(db.pragma('table_info(swap_events)').map((row) => row.name));
  assert.strictEqual(snapshotColumns.length, logger._snapshotColumnNames().length + 1);
  for (const name of [
    'source',
    'price_reliable',
    'price_sanitized',
    'raw_price',
    'raw_price_before',
    'sanitizer_reason',
    'data_quality_version',
  ]) {
    assert(swapColumns.has(name), `missing migrated swap_events.${name}`);
  }

  const ts = 1_800_000_000_000;
  logger.saveTokenSnapshot({
    ts,
    bucket_ts: ts,
    mint: 'CleanMint',
    price: 1,
    data_quality_version: 2,
  });
  logger.saveTokenSnapshot({
    ts: ts + 10,
    bucket_ts: ts,
    mint: 'CleanMint',
    price: 1,
    data_quality_version: 2,
  });
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM token_snapshots WHERE mint = 'CleanMint'").get().count,
    1,
  );

  logger.saveTokenSnapshot({
    ts,
    bucket_ts: ts,
    mint: 'LegacyMint',
    price: 1,
    data_quality_version: 1,
  });

  const events = [
    { ts: ts + 10_000, price: 1.1, quality: 2, signature: 'clean-10' },
    { ts: ts + 60_000, price: 1.2, quality: 2, signature: 'clean-60' },
    { ts: ts + 90_000, price: 100, quality: 1, signature: 'legacy-outlier' },
    { ts: ts + 180_000, price: 0.9, quality: 2, signature: 'clean-180' },
  ];
  for (const event of events) {
    logger.logSwapEvent({
      mint: 'CleanMint',
      side: 'BUY',
      solVolume: 1,
      price: event.price,
      priceBefore: event.price,
      ts: event.ts,
      signature: event.signature,
      dataQualityVersion: event.quality,
    });
  }
  logger.logSwapEvent({
    mint: 'NullPriceMint',
    side: 'SELL',
    solVolume: 1,
    price: null,
    ts: ts + 1,
    signature: 'null-price',
    dataQualityVersion: 2,
  });
  const nullPrice = db.prepare("SELECT price FROM swap_events WHERE mint = 'NullPriceMint'").get();
  assert.strictEqual(nullPrice.price, null);

  const updated = logger.backfillSnapshotLabels({ now: ts + 181_000, batchSize: 10 });
  assert.strictEqual(updated, 1);
  const clean = db.prepare("SELECT * FROM token_snapshots WHERE mint = 'CleanMint'").get();
  const legacy = db.prepare("SELECT * FROM token_snapshots WHERE mint = 'LegacyMint'").get();
  assert(Math.abs(clean.future_max_180s_pct - 20) < 1e-9);
  assert(Math.abs(clean.future_drawdown_180s_pct - (-10)) < 1e-9);
  assert.strictEqual(legacy.label_updated_at, null);

  new TradeLogger(db);
  if (typeof db.close === 'function') db.close();
  console.log(`Strategy Lab schema tests passed (${snapshotColumns.length - 1} exportable DB columns)`);
}

run();
