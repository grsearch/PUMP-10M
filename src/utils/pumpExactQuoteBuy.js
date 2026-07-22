'use strict';

const BN = require('bn.js');
const { TransactionInstruction } = require('@solana/web3.js');

const SLIPPAGE_PRECISION = new BN(1_000_000_000);

function asBn(value, field) {
  if (BN.isBN(value)) return value;
  try {
    return new BN(String(value));
  } catch (_) {
    throw new Error(`${field} must be an integer amount`);
  }
}

/**
 * Convert a percentage tolerance into the minimum base amount accepted by
 * buy_exact_quote_in. Ceiling division keeps the price cap conservative at
 * integer-token boundaries.
 */
function calculateMinBaseAmountOut(expectedBaseAmountOut, tolerancePct) {
  const expected = asBn(expectedBaseAmountOut, 'expectedBaseAmountOut');
  const tolerance = Number(tolerancePct);
  if (expected.lte(new BN(0))) {
    throw new Error('expectedBaseAmountOut must be > 0');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('tolerancePct must be >= 0');
  }

  const factorNumber = Math.floor((1 + tolerance / 100) * 1_000_000_000);
  if (!Number.isSafeInteger(factorNumber) || factorNumber <= 0) {
    throw new Error('tolerancePct is too large');
  }
  const factor = new BN(String(factorNumber));
  return expected
    .mul(SLIPPAGE_PRECISION)
    .add(factor.subn(1))
    .div(factor);
}

/**
 * PumpSwap SDK 1.19 exposes the buy_exact_quote_in IDL but does not yet expose
 * a high-level builder. Its own simulation test builds the normal BUY account
 * list and replaces only the instruction data. Keep that exact account list so
 * cashback, pool-v2, fee-recipient, Token-2022 and WSOL handling stay intact.
 */
function replaceBuyWithExactQuoteInstruction({
  instructions,
  programId,
  instructionCoder,
  spendableQuoteIn,
  minBaseAmountOut,
}) {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error('PumpSwap BUY instruction bundle is empty');
  }
  if (!programId || typeof programId.equals !== 'function') {
    throw new Error('PumpSwap program id is unavailable');
  }
  if (!instructionCoder || typeof instructionCoder.encode !== 'function') {
    throw new Error('PumpSwap instruction coder is unavailable');
  }

  const buyIndex = instructions.findIndex((ix) => (
    ix?.programId?.equals?.(programId) && ix.data && ix.data.length > 8
  ));
  if (buyIndex < 0) {
    throw new Error('PumpSwap BUY instruction not found in SDK bundle');
  }

  const quote = asBn(spendableQuoteIn, 'spendableQuoteIn');
  const minimumBase = asBn(minBaseAmountOut, 'minBaseAmountOut');
  if (quote.lte(new BN(0)) || minimumBase.lte(new BN(0))) {
    throw new Error('exact-quote BUY amounts must be > 0');
  }

  const data = instructionCoder.encode('buyExactQuoteIn', {
    spendableQuoteIn: quote,
    minBaseAmountOut: minimumBase,
    trackVolume: { 0: true },
  });
  const original = instructions[buyIndex];
  const exactQuoteInstruction = new TransactionInstruction({
    programId: original.programId,
    keys: original.keys,
    data,
  });

  const replaced = instructions.slice();
  replaced[buyIndex] = exactQuoteInstruction;
  return replaced;
}

module.exports = {
  calculateMinBaseAmountOut,
  replaceBuyWithExactQuoteInstruction,
};
