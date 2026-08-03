'use strict';

const assert = require('assert');
const {
  calculateBuyFailurePnlPct,
  isBuySlippageError,
  isExceededSlippageError,
  resolveSellSlippageBps,
} = require('../src/utils/executionSlippagePolicy');
const Executor = require('../src/core/Executor');
const PositionManager = require('../src/core/PositionManager');

async function run() {
  const policy = {
    baseBps: 3000,
    emergencyBps: 5000,
    retryStepBps: 1000,
    maxBps: 5000,
  };
  assert.strictEqual(resolveSellSlippageBps({ ...policy, reason: 'FAST_TP_5S', attempt: 1 }), 3000);
  assert.strictEqual(resolveSellSlippageBps({ ...policy, reason: 'LOSS_CHECK_6S', attempt: 1 }), 5000);
  assert.strictEqual(resolveSellSlippageBps({ ...policy, reason: 'HOLD_TIMEOUT_15S', attempt: 1 }), 5000);
  assert.strictEqual(resolveSellSlippageBps({ ...policy, reason: 'TRAILING_STOP', attempt: 2 }), 4000);
  assert.strictEqual(resolveSellSlippageBps({
    ...policy,
    reason: 'TRAILING_STOP',
    attempt: 2,
    lastError: '{"InstructionError":[3,{"Custom":6004}]}',
  }), 5000);
  assert.ok(isExceededSlippageError('ExceededSlippage (0x1774)'));
  assert.ok(isExceededSlippageError('{"InstructionError":[3,{"Custom":6004}]}'));
  assert.strictEqual(isExceededSlippageError('{"InstructionError":[9,{"Custom":6040}]}'), false);
  assert.strictEqual(isExceededSlippageError('{"Custom":6003}'), false);
  assert.ok(isBuySlippageError('BuySlippageBelowMinBaseAmountOut (0x1798)'));
  assert.ok(isBuySlippageError('Buy Slippage Below Min Base Amount Out (0x1798)'));
  assert.ok(isBuySlippageError('{"InstructionError":[9,{"Custom":6040}]}'));
  assert.ok(isBuySlippageError('{"InstructionError":[9,{"Custom":6004}]}'));
  assert.strictEqual(isBuySlippageError('{"Custom":6039}'), false);
  assert.strictEqual(calculateBuyFailurePnlPct(0.000505, 0.2), -0.2525);
  assert.strictEqual(calculateBuyFailurePnlPct(0, 0.2), 0);
  assert.strictEqual(calculateBuyFailurePnlPct(0.000505, 0), 0);

  // Executor must force a pool refresh and pass the requested 50% tolerance
  // to PumpAmmSdk; the diagnostics must preserve the state source and age.
  const executor = Object.create(Executor.prototype);
  executor.dryRun = false;
  executor.keypair = { publicKey: {} };
  let refreshOptions = null;
  let sdkSlippagePct = null;
  executor.poolStateCache = {
    getAge: () => refreshOptions ? 0 : 750,
    refreshOne: async (_pool, options) => {
      refreshOptions = options;
      return { id: 'fresh' };
    },
  };
  executor.onlineSdk = {
    swapSolanaState: async () => assert.fail('direct RPC fallback should not run'),
  };
  executor.pumpSdk = {
    sellBaseInput: async (_state, _amount, slippagePct) => {
      sdkSlippagePct = slippagePct;
      return { instructions: [{}] };
    },
  };
  executor._extractInstructions = () => [{}];
  executor._extractQuoteAmount = () => 100_000_000;
  executor._buildAndSignTx = async () => ({
    serialized: Buffer.alloc(65),
    feeInfo: { totalLamports: 5000, source: 'test' },
  });
  executor._submitTx = async () => {};

  const sell = await executor.sell({
    mint: '11111111111111111111111111111111',
    symbol: 'TEST',
    poolAddress: '11111111111111111111111111111111',
    tokenAmount: 1,
    baseDecimals: 6,
    currentPrice: 0.1,
    exitReason: 'LOSS_CHECK_6S',
    sellAttempt: 1,
    slippageBps: 5000,
  });
  assert.strictEqual(sell.success, true);
  assert.deepStrictEqual(refreshOptions, { maxAgeMs: 0, force: true });
  assert.strictEqual(sdkSlippagePct, 50);
  assert.strictEqual(sell.sellDiagnostics.stateSource, 'rpc_forced');
  assert.strictEqual(sell.sellDiagnostics.cacheAgeBeforeMs, 750);
  assert.strictEqual(sell.sellDiagnostics.effectiveSlippagePct, 50);

  // A confirmed BUY slippage error gets one fresh re-quote. Executor still owns
  // the no-chase signal-price guard, so this path cannot raise the permitted price.
  const manager = Object.create(PositionManager.prototype);
  manager.tokenRegistry = {
    getToken: () => ({ pool_address: 'pool', decimals: 6 }),
  };
  let markedFailed = null;
  let retryTrade = null;
  let updatedPosition = null;
  let reconciledSignature = null;
  manager.tradeLogger = {
    markBuyAttemptChainFailed: (...args) => { markedFailed = args; },
    logTrade: (trade) => { retryTrade = trade; },
    updatePositionBuySubmission: (_id, update) => { updatedPosition = update; },
  };
  manager.executor = {
    buy: async (order) => ({
      success: true,
      signature: 'retry-signature',
      solIn: order.sizeSol,
      tokenAmount: 2,
      price: 0.1,
      priorityFeeLamports: 10_000,
      buyDiagnostics: {
        signalPrice: order.signalPrice,
        spendableQuoteSol: order.sizeSol,
        effectiveSlippagePct: 10,
      },
    }),
  };
  manager._reconcileBuyAsync = async (_id, _mint, signature) => {
    reconciledSignature = signature;
  };
  const pos = {
    positionId: 'position',
    mint: 'mint',
    symbol: 'TEST',
    entrySol: 0.2,
    entryPrice: 0.1,
    tokenAmount: 2,
    buyFeeLamports: 500_000,
    buyDiagnostics: { signalPrice: 0.1, spendableQuoteSol: 0.2 },
    buy6004RetryCount: 0,
  };
  const retried = await manager._retryBuyAfterSlippage(
    pos,
    'position',
    'mint',
    'failed-signature',
    '{"Custom":6040}',
  );
  assert.strictEqual(retried, true);
  assert.ok(markedFailed);
  assert.strictEqual(retryTrade.reason, 'BUY_SLIPPAGE_REQUOTE_1');
  assert.strictEqual(updatedPosition.buySignature, 'retry-signature');
  assert.strictEqual(pos.failedBuyFeeLamports, 505_000);
  assert.strictEqual(reconciledSignature, 'retry-signature');

  // If the fresh quote is already above the signal cap, the retry remains a
  // local rejection: no second signature is submitted and no second chain fee exists.
  let locallyRejectedTrade = null;
  manager.executor.buy = async () => ({
    success: false,
    error: 'buy_price_guard: expected price above signal cap',
    priceGuardRejected: true,
    buyDiagnostics: {
      signalPrice: 0.1,
      expectedPrice: 0.101,
      maxPrice: 0.1,
    },
  });
  manager.tradeLogger.logTrade = (trade) => { locallyRejectedTrade = trade; };
  const rejectPos = {
    positionId: 'rejected-position',
    mint: 'mint',
    symbol: 'REJECT',
    entrySol: 0.2,
    entryPrice: 0.1,
    tokenAmount: 2,
    buyFeeLamports: 500_000,
    buyDiagnostics: { signalPrice: 0.1, spendableQuoteSol: 0.2 },
    buy6004RetryCount: 0,
  };
  const rejected = await manager._retryBuyAfterSlippage(
    rejectPos,
    'rejected-position',
    'mint',
    'failed-signature-2',
    '{"Custom":6040}',
  );
  assert.strictEqual(rejected, false);
  assert.strictEqual(locallyRejectedTrade.signature, undefined);
  assert.strictEqual(locallyRejectedTrade.success, false);
  assert.match(locallyRejectedTrade.error, /expected price above signal cap/);
  assert.strictEqual(rejectPos.failedBuyFeeLamports, 505_000);

  console.log('execution slippage policy tests passed');
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
