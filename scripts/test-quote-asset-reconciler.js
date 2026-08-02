'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { Keypair } = require('@solana/web3.js');
const {
  quoteAssetDelta,
  sumOwnerMintBalances,
  WSOL_MINT,
} = require('../src/utils/quoteAssetAccounting');
const QuoteAssetReconciler = require('../src/core/QuoteAssetReconciler');
const {
  nextScheduledAt,
  parsedTokenAmount,
} = require('../src/core/QuoteAssetReconciler');
const TradeLogger = require('../src/data/TradeLogger');
const { getMonitor } = require('../src/monitor/HealthMonitor');

const OWNER = 'Owner1111111111111111111111111111111111111';

function openMemoryDatabase() {
  try {
    return new Database(':memory:');
  } catch (err) {
    if (!/bindings file|better_sqlite3\.node/i.test(String(err?.message || err))) throw err;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.pragma = (statement) => db.prepare(`PRAGMA ${statement}`).all();
    return db;
  }
}

function tokenBalance(accountIndex, owner, mint, amount, decimals = 9) {
  return {
    accountIndex,
    owner,
    mint,
    uiTokenAmount: { amount: String(amount), decimals },
  };
}

function testQuoteDeltaIncludesWsol() {
  const message = { staticAccountKeys: [OWNER] };
  const meta = {
    preBalances: [2_000_000_000],
    postBalances: [1_999_500_000],
    preTokenBalances: [],
    postTokenBalances: [tokenBalance(2, OWNER, WSOL_MINT, 200_000_000)],
  };
  const result = quoteAssetDelta(meta, message, OWNER);
  assert(Math.abs(result.nativeSolDelta - (-0.0005)) < 1e-12);
  assert(Math.abs(result.wsolDelta - 0.2) < 1e-12);
  assert(Math.abs(result.quoteAssetDelta - 0.1995) < 1e-12);
}

function testUnwrapIsNotNewProfit() {
  const message = { accountKeys: [OWNER] };
  const meta = {
    preBalances: [1_000_000_000],
    postBalances: [2_001_844_400],
    preTokenBalances: [tokenBalance(3, OWNER, WSOL_MINT, 1_000_000_000)],
    postTokenBalances: [],
  };
  const result = quoteAssetDelta(meta, message, OWNER);
  assert(Math.abs(result.wsolDelta - (-1)) < 1e-12);
  // Only the rent/fee residual remains; the 1 WSOL -> SOL conversion is not PnL.
  assert(Math.abs(result.quoteAssetDelta - 0.0018444) < 1e-12);
}

function testExternalWsolIsNeverWalletAsset() {
  const routerVault = 'Router111111111111111111111111111111111111';
  const message = { staticAccountKeys: [OWNER, routerVault] };
  const meta = {
    preBalances: [2_000_000_000, 0],
    postBalances: [1_999_500_000, 0],
    preTokenBalances: [tokenBalance(1, 'router-owner', WSOL_MINT, 0)],
    postTokenBalances: [tokenBalance(1, 'router-owner', WSOL_MINT, 14_800_000)],
  };
  const result = quoteAssetDelta(meta, message, OWNER);
  assert.strictEqual(result.wsolDelta, 0);
  assert(Math.abs(result.quoteAssetDelta - (-0.0005)) < 1e-12);
}

function testBalanceAggregation() {
  const rows = [
    tokenBalance(1, OWNER, WSOL_MINT, 300_000_000),
    tokenBalance(2, OWNER, WSOL_MINT, 700_000_000),
    tokenBalance(3, 'other', WSOL_MINT, 900_000_000),
  ];
  assert.strictEqual(sumOwnerMintBalances(rows, OWNER, WSOL_MINT), 1);
}

function testBeijingSchedule() {
  const beforeMidnight = Date.UTC(2026, 7, 2, 15, 59, 0);
  assert.strictEqual(
    nextScheduledAt(beforeMidnight, [0, 6, 12, 18], 480),
    Date.UTC(2026, 7, 2, 16, 0, 0),
  );
  const afterMidnight = Date.UTC(2026, 7, 2, 16, 1, 0);
  assert.strictEqual(
    nextScheduledAt(afterMidnight, [0, 6, 12, 18], 480),
    Date.UTC(2026, 7, 2, 22, 0, 0),
  );
}

function testParsedAmount() {
  const account = {
    data: { parsed: { info: { tokenAmount: { amount: '1250000000', decimals: 9 } } } },
  };
  assert.strictEqual(parsedTokenAmount(account), 1.25);
}

async function testOnlyWalletControlledWsolIsCountedAndUnwrapped() {
  const keypair = Keypair.generate();
  const walletAddress = keypair.publicKey.toBase58();
  const tokenAccount1 = Keypair.generate().publicKey;
  const tokenAccount2 = Keypair.generate().publicKey;
  const foreignAccount = Keypair.generate().publicKey;
  let walletAmounts = ['15000000', '10000000'];
  let sentTransactions = 0;
  let externalReads = 0;
  const saved = [];
  const parsedRow = (pubkey, owner, amount, closeAuthority = null) => ({
    pubkey,
    account: {
      data: {
        parsed: {
          info: {
            owner,
            isNative: true,
            closeAuthority,
            tokenAmount: { amount, decimals: 9 },
          },
        },
      },
    },
  });
  const rpc = {
    getBalance: async () => 1_000_000_000,
    getParsedTokenAccountsByOwner: async () => ({
      value: [
        parsedRow(tokenAccount1, walletAddress, walletAmounts[0]),
        parsedRow(tokenAccount2, walletAddress, walletAmounts[1], walletAddress),
        // Defensive regression case: even if an RPC/provider ever leaks a
        // foreign account into an owner query, it must not be attributed.
        parsedRow(
          foreignAccount,
          'FtgZ6iPt4PjyHVyWRRhsooGVwA2U2vfDrTwtiStdqrXS',
          '14800000',
        ),
      ],
    }),
    getMultipleParsedAccounts: async () => {
      externalReads++;
      throw new Error('external accounts must never be read');
    },
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 123,
    }),
    sendRawTransaction: async () => {
      sentTransactions++;
      walletAmounts = ['0', '0'];
      return 'unwrap-signature';
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  const reconciler = new QuoteAssetReconciler({
    executor: { rpc, keypair },
    tradeLogger: { saveQuoteAssetSnapshot: (row) => saved.push(row) },
  });
  reconciler.settings = {
    ...reconciler.settings,
    enabled: true,
    autoUnwrapEnabled: true,
    autoUnwrapMinSol: 0.01,
    unknownWsolAlertMinSol: 0.01,
  };
  const monitor = getMonitor();
  monitor.fireAlert('quoteAsset.jupiterEscrowPending', 'warn', 'legacy false positive');
  monitor.fireAlert('quoteAsset.unknownExternalWsol', 'warn', 'legacy false positive');
  const result = await reconciler.reconcile({ allowUnwrap: true, reason: 'test' });
  assert.strictEqual(sentTransactions, 1);
  assert.strictEqual(externalReads, 0);
  assert.strictEqual(result.walletWsol, 0);
  assert.strictEqual(result.walletQuoteSol, 1);
  assert.strictEqual(result.walletWsolAccountCount, 2);
  assert.strictEqual(result.unknownWalletWsolAccountCount, 1);
  assert.deepStrictEqual(result.unwrapSignatures, ['unwrap-signature']);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual('jupiterPendingWsol' in result, false);
  const activeAlerts = monitor.report().active_alerts.map((alert) => alert.name);
  assert.strictEqual(activeAlerts.includes('quoteAsset.jupiterEscrowPending'), false);
  assert.strictEqual(activeAlerts.includes('quoteAsset.unknownExternalWsol'), false);
}

async function testTradingBusyNeverSigns() {
  const keypair = Keypair.generate();
  let rpcCalls = 0;
  const reconciler = new QuoteAssetReconciler({
    executor: {
      keypair,
      rpc: { getBalance: async () => { rpcCalls++; return 0; } },
    },
    tradeLogger: null,
    isTradingBusy: () => true,
  });
  reconciler.settings = { ...reconciler.settings, enabled: true };
  const result = await reconciler.reconcile({ allowUnwrap: true });
  assert.deepStrictEqual(result, { skipped: 'trading_busy' });
  assert.strictEqual(rpcCalls, 0);
}

async function testThresholdUsesOnlyClosableWsol() {
  const keypair = Keypair.generate();
  const walletAddress = keypair.publicKey.toBase58();
  let sentTransactions = 0;
  const row = (amount, closeAuthority = null) => ({
    pubkey: Keypair.generate().publicKey,
    account: {
      data: {
        parsed: {
          info: {
            owner: walletAddress,
            isNative: true,
            closeAuthority,
            tokenAmount: { amount, decimals: 9 },
          },
        },
      },
    },
  });
  const rpc = {
    getBalance: async () => 1_000_000_000,
    getParsedTokenAccountsByOwner: async () => ({
      value: [
        row('5000000'),
        row('20000000', Keypair.generate().publicKey.toBase58()),
      ],
    }),
    sendRawTransaction: async () => { sentTransactions++; return 'unexpected'; },
  };
  const reconciler = new QuoteAssetReconciler({
    executor: { rpc, keypair },
    tradeLogger: null,
  });
  reconciler.settings = {
    ...reconciler.settings,
    enabled: true,
    autoUnwrapEnabled: true,
    autoUnwrapMinSol: 0.01,
    unknownWsolAlertMinSol: 0.01,
  };
  const result = await reconciler.reconcile({ allowUnwrap: true, reason: 'threshold-test' });
  assert.strictEqual(result.walletWsol, 0.025);
  assert.strictEqual(result.autoUnwrapEligibleWsol, 0.005);
  assert.strictEqual(sentTransactions, 0);
}

async function testTradingStartsDuringSnapshotNeverSigns() {
  const keypair = Keypair.generate();
  const tokenAccount = Keypair.generate().publicKey;
  let busyChecks = 0;
  let sentTransactions = 0;
  const rpc = {
    getBalance: async () => 1_000_000_000,
    getParsedTokenAccountsByOwner: async () => ({
      value: [{
        pubkey: tokenAccount,
        account: {
          data: {
            parsed: {
              info: {
                owner: keypair.publicKey.toBase58(),
                isNative: true,
                tokenAmount: { amount: '25000000', decimals: 9 },
              },
            },
          },
        },
      }],
    }),
    sendRawTransaction: async () => { sentTransactions++; return 'unexpected'; },
  };
  const reconciler = new QuoteAssetReconciler({
    executor: { rpc, keypair },
    tradeLogger: null,
    // First check admits the snapshot; the pre-sign check blocks it.
    isTradingBusy: () => ++busyChecks >= 2,
  });
  reconciler.settings = {
    ...reconciler.settings,
    enabled: true,
    autoUnwrapEnabled: true,
    autoUnwrapMinSol: 0.01,
  };
  const result = await reconciler.reconcile({ allowUnwrap: true });
  assert.deepStrictEqual(result, { skipped: 'trading_busy' });
  assert.strictEqual(sentTransactions, 0);
}

function testAccountingTables() {
  const db = openMemoryDatabase();
  const logger = new TradeLogger(db);
  logger.saveQuoteAssetSnapshot({
    ts: 1,
    reason: 'test',
    wallet: OWNER,
    nativeSol: 2,
    walletWsol: 0.5,
    walletQuoteSol: 2.5,
  });
  logger.saveTxQuoteReconciliation({
    signature: 'sig',
    mint: 'mint',
    nativeSolDelta: -0.001,
    wsolDelta: 0.2,
    quoteAssetDelta: 0.199,
    tokenDelta: -10,
    feeLamports: 5_000,
    success: true,
  });
  const snapshot = db.prepare('SELECT * FROM quote_asset_snapshots').get();
  const tx = db.prepare('SELECT * FROM tx_quote_reconciliations').get();
  const snapshotColumns = db.prepare('PRAGMA table_info(quote_asset_snapshots)').all();
  const txColumns = db.prepare('PRAGMA table_info(tx_quote_reconciliations)').all();
  assert.strictEqual(snapshot.wallet_quote_sol, 2.5);
  assert.strictEqual(snapshotColumns.some((row) => /jupiter|escrow/.test(row.name)), false);
  assert.strictEqual(tx.quote_asset_delta, 0.199);
  assert.strictEqual(txColumns.some((row) => /jupiter|escrow/.test(row.name)), false);
  db.close();
}

function testIncorrectLegacySchemaIsNeutralized() {
  const db = openMemoryDatabase();
  db.exec(`
    CREATE TABLE quote_asset_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      native_sol REAL NOT NULL,
      wallet_wsol REAL NOT NULL,
      wallet_quote_sol REAL NOT NULL,
      external_escrow_wsol REAL NOT NULL,
      jupiter_pending_wsol REAL NOT NULL,
      total_quote_equity_sol REAL NOT NULL,
      wallet_wsol_account_count INTEGER NOT NULL DEFAULT 0,
      jupiter_escrow_account_count INTEGER NOT NULL DEFAULT 0,
      unwrap_signatures_json TEXT,
      details_json TEXT
    );
    CREATE TABLE tx_quote_reconciliations (
      signature TEXT PRIMARY KEY,
      parsed_at INTEGER NOT NULL,
      mint TEXT,
      native_sol_delta REAL,
      wsol_delta REAL,
      jupiter_wsol_delta REAL,
      quote_asset_delta REAL,
      token_delta REAL,
      fee_lamports INTEGER,
      success INTEGER NOT NULL DEFAULT 0
    );
  `);
  const logger = new TradeLogger(db);
  logger.saveQuoteAssetSnapshot({
    ts: 2,
    reason: 'legacy-compat',
    wallet: OWNER,
    nativeSol: 0.507,
    walletWsol: 0,
    walletQuoteSol: 0.507,
  });
  logger.saveTxQuoteReconciliation({
    signature: 'legacy-sig',
    nativeSolDelta: 0.1,
    wsolDelta: 0,
    quoteAssetDelta: 0.1,
    success: true,
  });
  const snapshot = db.prepare('SELECT * FROM quote_asset_snapshots').get();
  const tx = db.prepare('SELECT * FROM tx_quote_reconciliations').get();
  assert.strictEqual(snapshot.external_escrow_wsol, 0);
  assert.strictEqual(snapshot.jupiter_pending_wsol, 0);
  assert.strictEqual(snapshot.total_quote_equity_sol, 0.507);
  assert.strictEqual(tx.jupiter_wsol_delta, 0);
  db.close();
}

async function main() {
  testQuoteDeltaIncludesWsol();
  testUnwrapIsNotNewProfit();
  testExternalWsolIsNeverWalletAsset();
  testBalanceAggregation();
  testBeijingSchedule();
  testParsedAmount();
  await testOnlyWalletControlledWsolIsCountedAndUnwrapped();
  await testTradingBusyNeverSigns();
  await testThresholdUsesOnlyClosableWsol();
  await testTradingStartsDuringSnapshotNeverSigns();
  testAccountingTables();
  testIncorrectLegacySchemaIsNeutralized();
  console.log('Quote asset reconciler tests PASS');
  getMonitor().stop();
}

main().catch((err) => {
  getMonitor().stop();
  console.error(err);
  process.exitCode = 1;
});
