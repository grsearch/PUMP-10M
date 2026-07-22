'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const { Keypair, TransactionInstruction } = require('@solana/web3.js');
const {
  buyQuoteInput,
  OFFLINE_PUMP_AMM_PROGRAM,
  PUMP_AMM_PROGRAM_ID,
} = require('@pump-fun/pump-swap-sdk');
const {
  calculateMinBaseAmountOut,
  replaceBuyWithExactQuoteInstruction,
} = require('../src/utils/pumpExactQuoteBuy');
const Executor = require('../src/core/Executor');

function publicKey() {
  return Keypair.generate().publicKey;
}

async function run() {
  const sdkEntry = require.resolve('@pump-fun/pump-swap-sdk');
  const sdkPackage = JSON.parse(
    fs.readFileSync(path.join(path.dirname(sdkEntry), '..', 'package.json'), 'utf8'),
  );
  assert.strictEqual(sdkPackage.version, '1.19.0');

  const baseMint = publicKey();
  const baseMintAccount = {
    mintAuthorityOption: 0,
    mintAuthority: publicKey(),
    supply: 1n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: publicKey(),
  };
  const globalConfig = {
    admin: publicKey(),
    lpFeeBasisPoints: new BN(30),
    protocolFeeBasisPoints: new BN(20),
    disableFlags: 0,
    protocolFeeRecipients: [],
    coinCreatorFeeBasisPoints: new BN(0),
    adminSetCoinCreatorAuthority: publicKey(),
    whitelistPda: publicKey(),
    reservedFeeRecipient: publicKey(),
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
    buybackFeeRecipients: [],
    buybackBasisPoints: new BN(0),
    boostAuthority: publicKey(),
    boostEnabled: false,
  };
  const quoteArgs = {
    quote: new BN(100_000),
    slippage: 0,
    baseReserve: new BN(1_000_000),
    quoteReserve: new BN(2_000_000),
    globalConfig,
    baseMintAccount,
    baseMint,
    coinCreator: publicKey(),
    creator: publicKey(),
    feeConfig: null,
  };
  const rawReserveQuote = buyQuoteInput(quoteArgs);
  const virtualReserveQuote = buyQuoteInput({
    ...quoteArgs,
    virtualQuoteReserves: new BN(2_000_000),
  });
  assert.ok(
    virtualReserveQuote.base.lt(rawReserveQuote.base),
    'virtual_quote_reserves must affect the SDK quote',
  );

  const spendableQuoteIn = new BN(100_000_000);
  const expectedBaseAmountOut = new BN(1_000_000);
  const minBaseAmountOut = calculateMinBaseAmountOut(expectedBaseAmountOut, 15);
  assert.strictEqual(minBaseAmountOut.toString(), '869566');

  const keys = [{ pubkey: publicKey(), isSigner: false, isWritable: true }];
  const original = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys,
    data: Buffer.alloc(25, 1),
  });
  const untouched = new TransactionInstruction({
    programId: publicKey(),
    keys: [],
    data: Buffer.from([7]),
  });
  const instructions = replaceBuyWithExactQuoteInstruction({
    instructions: [untouched, original],
    programId: PUMP_AMM_PROGRAM_ID,
    instructionCoder: OFFLINE_PUMP_AMM_PROGRAM.coder.instruction,
    spendableQuoteIn,
    minBaseAmountOut,
  });

  assert.strictEqual(instructions[0], untouched);
  assert.notStrictEqual(instructions[1], original);
  assert.deepStrictEqual(instructions[1].keys, keys);
  const decoded = OFFLINE_PUMP_AMM_PROGRAM.coder.instruction.decode(instructions[1].data);
  assert.strictEqual(decoded.name, 'buyExactQuoteIn');
  assert.strictEqual(decoded.data.spendableQuoteIn.toString(), spendableQuoteIn.toString());
  assert.strictEqual(decoded.data.minBaseAmountOut.toString(), minBaseAmountOut.toString());
  assert.deepStrictEqual(decoded.data.trackVolume, { 0: true });

  // Executor must fund/build with the exact position SOL amount. The third
  // buyInstructions argument controls WSOL funding in SDK 1.19.
  const executor = Object.create(Executor.prototype);
  executor.pumpAmmProgramId = PUMP_AMM_PROGRAM_ID;
  executor.pumpAmmInstructionCoder = OFFLINE_PUMP_AMM_PROGRAM.coder.instruction;
  executor.pumpSdk = {
    buyInstructions: async (state, baseOut, maxQuoteIn) => {
      assert.strictEqual(state.id, 'fresh-state');
      assert.strictEqual(baseOut.toString(), minBaseAmountOut.toString());
      assert.strictEqual(maxQuoteIn.toString(), spendableQuoteIn.toString());
      return [untouched, original];
    },
  };
  const executorInstructions = await executor._buildExactQuoteBuyInstructions(
    { id: 'fresh-state' },
    spendableQuoteIn,
    minBaseAmountOut,
  );
  const executorDecoded = OFFLINE_PUMP_AMM_PROGRAM.coder.instruction.decode(
    executorInstructions[1].data,
  );
  assert.strictEqual(executorDecoded.name, 'buyExactQuoteIn');
  assert.strictEqual(
    executorDecoded.data.spendableQuoteIn.toString(),
    spendableQuoteIn.toString(),
  );

  console.log('PumpSwap exact-quote BUY tests passed');
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
