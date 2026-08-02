'use strict';

const {
  PublicKey,
  Transaction,
} = require('@solana/web3.js');
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} = require('@solana/spl-token');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('QuoteAssetReconciler', {
  staleMs: 7 * 60 * 60_000,
  label: 'SOL/WSOL Reconciler',
});

function parsedTokenAmount(accountInfo) {
  const info = accountInfo?.data?.parsed?.info;
  const tokenAmount = info?.tokenAmount;
  const raw = Number(tokenAmount?.amount);
  const decimals = Number(tokenAmount?.decimals);
  return Number.isFinite(raw) && Number.isInteger(decimals) && decimals >= 0
    ? raw / (10 ** decimals)
    : 0;
}

function nextScheduledAt(nowMs, hours, utcOffsetMinutes) {
  const dayMs = 24 * 60 * 60_000;
  const offsetMs = utcOffsetMinutes * 60_000;
  const localNow = nowMs + offsetMs;
  const localDayStart = Math.floor(localNow / dayMs) * dayMs;
  const candidates = [...hours]
    .sort((a, b) => a - b)
    .map((hour) => localDayStart + hour * 60 * 60_000 - offsetMs);
  const today = candidates.find((ts) => ts > nowMs);
  return today ?? candidates[0] + dayMs;
}

class QuoteAssetReconciler {
  constructor({ executor, tradeLogger, isTradingBusy = () => false }) {
    this.executor = executor;
    this.tradeLogger = tradeLogger;
    this.isTradingBusy = isTradingBusy;
    this.settings = config.quoteAssetReconciler;
    this.rpc = executor?.rpc || null;
    this.keypair = executor?.keypair || null;
    this.scheduleTimer = null;
    this.refreshTimer = null;
    this.running = false;
    this.latestSnapshot = null;
  }

  start() {
    if (!this.settings.enabled || !this.rpc || !this.keypair) {
      monitor.set('QuoteAssetReconciler.enabled', 0, 'QuoteAssetReconciler');
      return;
    }
    monitor.set('QuoteAssetReconciler.enabled', 1, 'QuoteAssetReconciler');
    this._scheduleNext();
    // Startup is read-only. Automatic account closure remains restricted to
    // the four scheduled Beijing-time maintenance windows.
    this.requestRefresh('startup', 0);
  }

  stop() {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.scheduleTimer = null;
    this.refreshTimer = null;
  }

  getLatestSnapshot() {
    return this.latestSnapshot;
  }

  requestRefresh(reason = 'event', delayMs = 1_000) {
    if (!this.settings.enabled || !this.rpc || !this.keypair) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      const result = await this.reconcile({ allowUnwrap: false, reason });
      if (
        result?.error ||
        result?.skipped === 'trading_busy' ||
        result?.skipped === 'already_running'
      ) {
        this.requestRefresh(reason, this.settings.busyRetryMs);
      }
    }, Math.max(0, delayMs));
    this.refreshTimer.unref?.();
  }

  _scheduleNext() {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    const nextRunAt = nextScheduledAt(
      Date.now(),
      this.settings.scheduleHours,
      this.settings.utcOffsetMinutes,
    );
    monitor.set('QuoteAssetReconciler.nextRunAt', nextRunAt, 'QuoteAssetReconciler');
    this.scheduleTimer = setTimeout(
      () => this._runScheduled(),
      Math.max(1_000, nextRunAt - Date.now()),
    );
    this.scheduleTimer.unref?.();
  }

  _scheduleBusyRetry() {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    const nextRunAt = Date.now() + this.settings.busyRetryMs;
    monitor.set('QuoteAssetReconciler.nextRunAt', nextRunAt, 'QuoteAssetReconciler');
    this.scheduleTimer = setTimeout(() => this._runScheduled(), this.settings.busyRetryMs);
    this.scheduleTimer.unref?.();
  }

  async _runScheduled() {
    const result = await this.reconcile({ allowUnwrap: true, reason: 'scheduled' });
    if (
      result?.error ||
      result?.skipped === 'trading_busy' ||
      result?.skipped === 'already_running'
    ) {
      this._scheduleBusyRetry();
    } else {
      this._scheduleNext();
    }
  }

  async reconcile({ allowUnwrap = false, reason = 'manual' } = {}) {
    if (!this.settings.enabled || !this.rpc || !this.keypair) {
      return { skipped: 'disabled' };
    }
    if (this.running) return { skipped: 'already_running' };
    if (this.isTradingBusy()) {
      monitor.inc('QuoteAssetReconciler.skippedTradingBusy', 1, 'QuoteAssetReconciler');
      return { skipped: 'trading_busy' };
    }

    this.running = true;
    try {
      let snapshot = await this._readSnapshot(reason);
      const shouldUnwrap = allowUnwrap &&
        this.settings.autoUnwrapEnabled &&
        snapshot.autoUnwrapEligibleWsol >= this.settings.autoUnwrapMinSol &&
        snapshot.unwrapAccounts.length > 0;

      // Recheck immediately before signing. A signal or sell may have started
      // while the RPC snapshot was loading.
      if (shouldUnwrap && this.isTradingBusy()) {
        monitor.inc('QuoteAssetReconciler.skippedTradingBusy', 1, 'QuoteAssetReconciler');
        return { skipped: 'trading_busy' };
      }

      let interrupted = false;
      if (shouldUnwrap) {
        const unwrapResult = await this._unwrap(snapshot.unwrapAccounts);
        const signatures = unwrapResult.signatures;
        interrupted = unwrapResult.interrupted;
        snapshot = await this._readSnapshot(reason);
        snapshot.unwrapSignatures = signatures;
        monitor.inc('QuoteAssetReconciler.unwrapRuns', 1, 'QuoteAssetReconciler');
        console.log(
          `[QuoteAssetReconciler] unwrapped wallet WSOL: ` +
          `${signatures.length} tx(s), remaining=${snapshot.walletWsol.toFixed(6)} WSOL`,
        );
      }

      this._publish(snapshot);
      return interrupted ? { ...snapshot, skipped: 'trading_busy' } : snapshot;
    } catch (err) {
      monitor.recordError('QuoteAssetReconciler', err, { phase: 'reconcile', reason });
      monitor.inc('QuoteAssetReconciler.failures', 1, 'QuoteAssetReconciler');
      console.error(`[QuoteAssetReconciler] reconcile failed: ${err.message}`);
      return { error: err.message };
    } finally {
      this.running = false;
    }
  }

  async _readSnapshot(reason) {
    const owner = this.keypair.publicKey;
    const [nativeLamports, tokenAccounts] = await Promise.all([
      this.rpc.getBalance(owner, 'confirmed'),
      this.rpc.getParsedTokenAccountsByOwner(
        owner,
        { mint: NATIVE_MINT },
        'confirmed',
      ),
    ]);

    const ownerAddress = owner.toBase58();
    const walletAccounts = (tokenAccounts?.value || []).map((row) => {
      const info = row.account?.data?.parsed?.info || {};
      const closeAuthority = info.closeAuthority || null;
      const amountSol = parsedTokenAmount(row.account);
      const authority = info.owner || null;
      const walletControlled = authority === ownerAddress;
      const canWalletClose = walletControlled &&
        (!closeAuthority || closeAuthority === ownerAddress);
      return {
        address: row.pubkey.toBase58(),
        amountSol,
        isNative: info.isNative === true,
        authority,
        closeAuthority,
        walletControlled,
        canWalletClose,
      };
    });
    const unwrapAccounts = walletAccounts.filter((row) =>
      row.amountSol > 0 && row.walletControlled && row.isNative && row.canWalletClose,
    );
    const unknownWalletAccounts = walletAccounts.filter((row) =>
      row.amountSol >= this.settings.unknownWsolAlertMinSol &&
      (!row.walletControlled || !row.isNative || !row.canWalletClose),
    );
    const controlledWalletAccounts = walletAccounts.filter((row) => row.walletControlled);
    const walletWsol = controlledWalletAccounts.reduce(
      (sum, row) => sum + row.amountSol,
      0,
    );
    const autoUnwrapEligibleWsol = unwrapAccounts.reduce(
      (sum, row) => sum + row.amountSol,
      0,
    );
    const nativeSol = nativeLamports / 1_000_000_000;
    const walletQuoteSol = nativeSol + walletWsol;

    return {
      ts: Date.now(),
      reason,
      wallet: ownerAddress,
      nativeSol,
      walletWsol,
      walletQuoteSol,
      autoUnwrapEligibleWsol,
      walletWsolAccountCount: controlledWalletAccounts.length,
      unknownWalletWsolAccountCount: unknownWalletAccounts.length,
      walletAccounts,
      unwrapAccounts,
      unknownWalletAccounts,
      unwrapSignatures: [],
    };
  }

  async _unwrap(accounts) {
    const signatures = [];
    const owner = this.keypair.publicKey;
    const chunkSize = 6;

    for (let start = 0; start < accounts.length; start += chunkSize) {
      if (this.isTradingBusy()) return { signatures, interrupted: true };
      const chunk = accounts.slice(start, start + chunkSize);
      const latest = await this.rpc.getLatestBlockhash('confirmed');
      if (this.isTradingBusy()) return { signatures, interrupted: true };
      const tx = new Transaction({
        feePayer: owner,
        recentBlockhash: latest.blockhash,
      });
      for (const account of chunk) {
        tx.add(createCloseAccountInstruction(
          new PublicKey(account.address),
          owner,
          owner,
          [],
          TOKEN_PROGRAM_ID,
        ));
      }
      if (this.isTradingBusy()) return { signatures, interrupted: true };
      tx.sign(this.keypair);
      const signature = await this.rpc.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const confirmation = await this.rpc.confirmTransaction({
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }, 'confirmed');
      if (confirmation?.value?.err) {
        throw new Error(`WSOL unwrap failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      signatures.push(signature);
    }
    return { signatures, interrupted: false };
  }

  _publish(snapshot) {
    const publicSnapshot = {
      ts: snapshot.ts,
      reason: snapshot.reason,
      wallet: snapshot.wallet,
      nativeSol: snapshot.nativeSol,
      walletWsol: snapshot.walletWsol,
      walletQuoteSol: snapshot.walletQuoteSol,
      autoUnwrapEligibleWsol: snapshot.autoUnwrapEligibleWsol,
      walletWsolAccountCount: snapshot.walletWsolAccountCount,
      unknownWalletWsolAccountCount: snapshot.unknownWalletWsolAccountCount,
      unwrapSignatures: snapshot.unwrapSignatures,
    };
    this.latestSnapshot = publicSnapshot;

    monitor.beat('QuoteAssetReconciler', 'reconciled');
    monitor.set('QuoteAssetReconciler.nativeSol', snapshot.nativeSol, 'QuoteAssetReconciler');
    monitor.set('QuoteAssetReconciler.walletWsol', snapshot.walletWsol, 'QuoteAssetReconciler');
    monitor.set('QuoteAssetReconciler.walletQuoteSol', snapshot.walletQuoteSol, 'QuoteAssetReconciler');
    monitor.set(
      'QuoteAssetReconciler.autoUnwrapEligibleWsol',
      snapshot.autoUnwrapEligibleWsol,
      'QuoteAssetReconciler',
    );
    monitor.set('QuoteAssetReconciler.lastRunAt', snapshot.ts, 'QuoteAssetReconciler');

    // Clear false-positive alerts left by the former router-vault monitor.
    // External accounts are never treated as wallet assets.
    monitor.clearAlert('quoteAsset.jupiterEscrowPending');
    monitor.clearAlert('quoteAsset.unknownExternalWsol');

    if (snapshot.unknownWalletAccounts.length > 0) {
      monitor.fireAlert(
        'quoteAsset.walletWsolManualReview',
        'warn',
        `${snapshot.unknownWalletAccounts.length} wallet WSOL account(s) require manual review`,
        { accounts: snapshot.unknownWalletAccounts },
      );
    } else {
      monitor.clearAlert('quoteAsset.walletWsolManualReview');
    }

    this.tradeLogger?.saveQuoteAssetSnapshot?.({
      ...publicSnapshot,
      details: {
        walletAccounts: snapshot.walletAccounts,
        unknownWalletAccounts: snapshot.unknownWalletAccounts,
      },
    });

    console.log(
      `[QuoteAssetReconciler] native=${snapshot.nativeSol.toFixed(6)} ` +
      `walletWSOL=${snapshot.walletWsol.toFixed(6)} ` +
      `walletQuote=${snapshot.walletQuoteSol.toFixed(6)}`,
    );
  }
}

module.exports = QuoteAssetReconciler;
module.exports.nextScheduledAt = nextScheduledAt;
module.exports.parsedTokenAmount = parsedTokenAmount;
