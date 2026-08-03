'use strict';

const EventEmitter = require('events');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');
const { normalizeUnixMs } = require('../utils/migrationTime');

const monitor = getMonitor();

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Live entry tracker for newly migrated Pump tokens.
 *
 * A candidate starts when the trusted price crosses into a 10%-20% drawdown
 * from the rolling one-second high. The first rebound from the running low
 * must reach 2%-5% before the one-second candidate deadline.
 */
class DropReboundTracker extends EventEmitter {
  constructor(opts = {}) {
    super();
    const settings = config.activityFlow || {};
    this.tokenRegistry = opts.tokenRegistry || null;
    this.tradeLogger = opts.tradeLogger || null;
    this.enabled = opts.enabled ?? settings.enabled ?? true;
    this.replaceDumpSignal = opts.replaceDumpSignal ?? settings.replaceDumpSignal ?? true;
    this.entryMode = 'DROP_REBOUND_1S';
    this.dropWindowMs = opts.dropWindowMs ?? settings.dropWindowMs ?? 1_000;
    this.dropMinPct = opts.dropMinPct ?? settings.dropMinPct ?? 10;
    this.dropMaxPct = opts.dropMaxPct ?? settings.dropMaxPct ?? 20;
    this.reboundMinPct = opts.reboundMinPct ?? settings.reboundMinPct ?? 2;
    this.reboundMaxPct = opts.reboundMaxPct ?? settings.reboundMaxPct ?? 5;
    this.reboundTimeoutMs = opts.reboundTimeoutMs ?? settings.reboundTimeoutMs ?? 1_000;
    this.maxSignalAgeMs = opts.maxSignalAgeMs ?? settings.maxSignalAgeMs ?? 5_000;
    this.inflightTimeoutMs = Math.max(5_000, Number(opts.inflightTimeoutMs ?? 30_000) || 30_000);
    this.minFdvUsd = opts.minFdvUsd ?? config.strategy.minFdVUsd;
    this.maxFdvUsd = opts.maxFdvUsd ?? config.strategy.maxFdVUsd;
    this.minLiquidityUsd = opts.minLiquidityUsd ?? config.strategy.minLiquidityUsd;
    this.maxTokenAgeMs = opts.maxTokenAgeMs ?? config.strategy.maxTokenAgeMs;
    this.states = new Map();
  }

  _stateOf(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = {
        mint,
        symbol: null,
        poolAddress: null,
        lastPoolQuoteAfter: null,
        prices: [],
        recentEventKeys: new Map(),
        lastProcessedTs: 0,
        latestPrice: null,
        rollingHigh: null,
        rollingDropPct: null,
        dropReady: true,
        candidate: null,
        stage: 'monitoring',
        waitReason: 'waiting for a 10%-20% drop inside one second',
        lastSignalTs: null,
        lastSignal: null,
        inflight: false,
        inflightAt: null,
        lastDumpSignal: null,
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _eventKey(swap, ts, price) {
    if (swap.signature) return `${swap.signature}:${String(swap.side || '').toUpperCase()}`;
    return `${ts}:${price}:${String(swap.side || '').toUpperCase()}:${Number(swap.solVolume) || 0}`;
  }

  _prune(state, now) {
    const cutoff = now - this.dropWindowMs;
    while (state.prices.length > 0 && state.prices[0].ts < cutoff) {
      state.prices.shift();
    }
    const dedupCutoff = now - Math.max(this.maxSignalAgeMs, 5_000);
    for (const [key, ts] of state.recentEventKeys) {
      if (ts < dedupCutoff) state.recentEventKeys.delete(key);
    }
  }

  _entryFilter(state, signalTs) {
    const token = this.tokenRegistry?.getToken?.(state.mint);
    if (!token || token.is_active === 0) return 'token is not active';

    const fdv = finite(token.fdv);
    if (fdv == null) return 'FDV unavailable';
    if (fdv < this.minFdvUsd) return `FDV $${Math.round(fdv)}<$${this.minFdvUsd}`;
    if (this.maxFdvUsd > 0 && fdv > this.maxFdvUsd) {
      return `FDV $${Math.round(fdv)}>$${this.maxFdvUsd}`;
    }

    if (this.minLiquidityUsd > 0) {
      const liquidity = finite(token.liquidity);
      if (liquidity == null) return 'LP unavailable';
      if (liquidity < this.minLiquidityUsd) {
        return `LP $${Math.round(liquidity)}<$${this.minLiquidityUsd}`;
      }
    }

    const migrationTime = normalizeUnixMs(token.migration_time);
    if (!migrationTime) return 'migration AGE unavailable';
    const ageMs = Math.max(0, signalTs - migrationTime);
    if (this.maxTokenAgeMs > 0 && ageMs >= this.maxTokenAgeMs) {
      return `AGE ${(ageMs / 60_000).toFixed(2)}m>=${this.maxTokenAgeMs / 60_000}m`;
    }
    return null;
  }

  _candidateView(candidate, price) {
    if (!candidate) return {};
    const dropPct = (candidate.lowPrice / candidate.peakPrice - 1) * 100;
    const reboundPct = (price / candidate.lowPrice - 1) * 100;
    return {
      peakPrice: candidate.peakPrice,
      peakTs: candidate.peakTs,
      lowPrice: candidate.lowPrice,
      lowTs: candidate.lowTs,
      dropStartedAt: candidate.startedAt,
      waitUntil: candidate.expiresAt,
      dropPct,
      reboundPct,
    };
  }

  _cancelCandidate(state, reason, stage = 'monitoring') {
    state.candidate = null;
    state.stage = stage;
    state.waitReason = reason;
  }

  _emitEntry(state, ev, candidate, dropPct, reboundPct) {
    const filterReason = this._entryFilter(state, ev.ts);
    if (filterReason) {
      monitor.inc('DropReboundTracker.rejectedEntryFilter', 1, 'DropReboundTracker');
      this._cancelCandidate(state, filterReason, 'ineligible');
      return;
    }

    if (state.inflight) {
      const lockAgeMs = Date.now() - (state.inflightAt || Date.now());
      if (lockAgeMs < this.inflightTimeoutMs) return;
      state.inflight = false;
      state.inflightAt = null;
      monitor.inc('DropReboundTracker.staleInflightCleared', 1, 'DropReboundTracker');
    }

    const recent = state.prices.filter((row) => row.ts >= ev.ts - this.dropWindowMs);
    const sellRows = recent.filter((row) => row.side === 'SELL');
    const signalDetails = {
      dropWindowMs: this.dropWindowMs,
      dropMinPct: this.dropMinPct,
      dropMaxPct: this.dropMaxPct,
      reboundMinPct: this.reboundMinPct,
      reboundMaxPct: this.reboundMaxPct,
      reboundTimeoutMs: this.reboundTimeoutMs,
      peakPrice: candidate.peakPrice,
      peakTs: candidate.peakTs,
      lowPrice: candidate.lowPrice,
      lowTs: candidate.lowTs,
      dropPct: round(dropPct),
      reboundPct: round(reboundPct),
      reboundElapsedMs: ev.ts - candidate.startedAt,
      reboundFromLowMs: ev.ts - candidate.lowTs,
      executionPrice: ev.price,
    };
    const signal = {
      mint: ev.mint,
      symbol: state.symbol || ev.symbol,
      sellSol: round(sellRows.reduce((sum, row) => sum + row.solVolume, 0), 6) || 0,
      priceImpactPct: round(Math.abs(dropPct), 4) || 0,
      poolQuoteAfter: ev.poolQuoteAfter || state.lastPoolQuoteAfter || null,
      poolQuoteSol: ev.poolQuoteAfter || state.lastPoolQuoteAfter || null,
      seller: null,
      signature: `drop-rebound:${ev.mint}:${candidate.startedAt}:${ev.ts}`,
      ts: ev.ts,
      slot: ev.slot || 0,
      poolAddress: ev.poolAddress || state.poolAddress,
      priceAfter: ev.price,
      priceBefore: candidate.peakPrice,
      _aggregated: true,
      _activityFlow: true,
      _strategySignal: true,
      _sellCount: sellRows.length,
      _sellCount10s: sellRows.length,
      _totalSellSol10s: round(sellRows.reduce((sum, row) => sum + row.solVolume, 0), 6) || 0,
      _sellers: [],
      _flow: { entryDropRebound1s: signalDetails },
      _flowPattern: signalDetails,
    };

    state.candidate = null;
    state.stage = 'signaled';
    state.waitReason = null;
    state.lastSignalTs = ev.ts;
    state.lastSignal = signalDetails;
    state.inflight = true;
    state.inflightAt = Date.now();
    monitor.inc('DropReboundTracker.signalsEmitted', 1, 'DropReboundTracker');
    console.log(
      `[DropRebound] BUY_CONFIRM ${signal.symbol || ev.mint.slice(0, 6)} ` +
        `drop=${dropPct.toFixed(2)}% rebound=+${reboundPct.toFixed(2)}% ` +
        `elapsed=${signalDetails.reboundElapsedMs}ms price=${ev.price}`,
    );
    this.emit('flowReversalSignal', signal);
  }

  handleSwap(swap) {
    if (!this.enabled || !swap?.mint) return;
    const price = finite(swap.price);
    const solVolume = finite(swap.solVolume);
    const ts = finite(swap.ts) ?? Date.now();
    if (price == null || price <= 0 || solVolume == null || solVolume <= 0) return;
    if (Date.now() - ts > this.maxSignalAgeMs) {
      monitor.inc('DropReboundTracker.rejectedStaleSwap', 1, 'DropReboundTracker');
      return;
    }

    const state = this._stateOf(swap.mint);
    if (
      state.inflight &&
      Date.now() - (state.inflightAt || Date.now()) >= this.inflightTimeoutMs
    ) {
      state.inflight = false;
      state.inflightAt = null;
      monitor.inc('DropReboundTracker.staleInflightCleared', 1, 'DropReboundTracker');
    }
    const eventKey = this._eventKey(swap, ts, price);
    if (state.recentEventKeys.has(eventKey)) {
      monitor.inc('DropReboundTracker.duplicateSwap', 1, 'DropReboundTracker');
      return;
    }
    if (state.lastProcessedTs && ts < state.lastProcessedTs) {
      monitor.inc('DropReboundTracker.outOfOrderSwap', 1, 'DropReboundTracker');
      return;
    }
    state.recentEventKeys.set(eventKey, ts);
    state.lastProcessedTs = ts;
    state.symbol = swap.symbol || state.symbol;
    state.poolAddress = swap.poolAddress || state.poolAddress;
    state.lastPoolQuoteAfter = finite(swap.poolQuoteAfter) || state.lastPoolQuoteAfter;

    const ev = {
      mint: swap.mint,
      symbol: swap.symbol || state.symbol,
      side: String(swap.side || '').toUpperCase(),
      signer: swap.signer || null,
      solVolume,
      price,
      ts,
      slot: swap.slot || 0,
      signature: swap.signature || null,
      poolAddress: swap.poolAddress || state.poolAddress,
      poolQuoteAfter: finite(swap.poolQuoteAfter),
    };
    state.prices.push(ev);
    this._prune(state, ts);
    state.latestPrice = price;

    let rollingPeak = price;
    let rollingPeakTs = ts;
    for (const row of state.prices) {
      if (row.price > rollingPeak) {
        rollingPeak = row.price;
        rollingPeakTs = row.ts;
      }
    }
    const rollingDropPct = (price / rollingPeak - 1) * 100;
    state.rollingHigh = rollingPeak;
    state.rollingDropPct = rollingDropPct;
    if (rollingDropPct > -this.dropMinPct) state.dropReady = true;
    if (rollingDropPct < -this.dropMaxPct) state.dropReady = false;

    if (state.candidate) {
      const candidate = state.candidate;
      if (ts > candidate.expiresAt) {
        monitor.inc('DropReboundTracker.reboundTimeout', 1, 'DropReboundTracker');
        this._cancelCandidate(state, `rebound timeout: ${ts - candidate.startedAt}ms>${this.reboundTimeoutMs}ms`);
      } else {
        if (price < candidate.lowPrice) {
          candidate.lowPrice = price;
          candidate.lowTs = ts;
        }
        const dropPct = (candidate.lowPrice / candidate.peakPrice - 1) * 100;
        if (dropPct < -this.dropMaxPct) {
          monitor.inc('DropReboundTracker.dropExceededMax', 1, 'DropReboundTracker');
          this._cancelCandidate(state, `drop ${dropPct.toFixed(2)}% exceeded -${this.dropMaxPct}%`);
        } else {
          const reboundPct = (price / candidate.lowPrice - 1) * 100;
          if (reboundPct >= this.reboundMinPct) {
            if (reboundPct > this.reboundMaxPct) {
              monitor.inc('DropReboundTracker.reboundJumpedMax', 1, 'DropReboundTracker');
              this._cancelCandidate(
                state,
                `first rebound +${reboundPct.toFixed(2)}% exceeded +${this.reboundMaxPct}%`,
              );
            } else {
              this._emitEntry(state, ev, candidate, dropPct, reboundPct);
            }
          } else {
            state.stage = 'waiting';
            state.waitReason = `rebound +${reboundPct.toFixed(2)}%<+${this.reboundMinPct}%`;
          }
        }
      }
    }

    if (
      !state.candidate &&
      !state.inflight &&
      state.dropReady &&
      rollingDropPct <= -this.dropMinPct &&
      rollingDropPct >= -this.dropMaxPct
    ) {
      state.candidate = {
        peakPrice: rollingPeak,
        peakTs: rollingPeakTs,
        lowPrice: price,
        lowTs: ts,
        startedAt: ts,
        expiresAt: ts + this.reboundTimeoutMs,
      };
      state.dropReady = false;
      state.stage = 'waiting';
      state.waitReason = `drop ${rollingDropPct.toFixed(2)}%; waiting for +${this.reboundMinPct}% rebound`;
      monitor.inc('DropReboundTracker.dropCandidates', 1, 'DropReboundTracker');
    } else if (!state.candidate && !state.inflight && state.stage !== 'ineligible') {
      state.stage = 'monitoring';
      if (rollingDropPct > -this.dropMinPct) {
        state.waitReason = `drop ${rollingDropPct.toFixed(2)}% has not reached -${this.dropMinPct}%`;
      }
    }
  }

  handleVolumeSwap() {
    // Price-ineligible events must not participate in a price signal.
  }

  updateRsiSnapshot() {
    // Compatibility no-op. RSI is not part of this strategy.
  }

  clearInflight(mint) {
    const state = this.states.get(mint);
    if (!state || !state.inflight) return false;
    state.inflight = false;
    state.inflightAt = null;
    if (state.stage === 'signaled') {
      state.stage = 'monitoring';
      state.waitReason = 'signal completed; waiting for a new drop episode';
    }
    return true;
  }

  clearRsi1sInflight(mint) {
    return this.clearInflight(mint);
  }

  noteSuppressedDumpSignal(signal) {
    if (!signal?.mint) return;
    this._stateOf(signal.mint).lastDumpSignal = signal;
  }

  removeMint(mint) {
    this.states.delete(mint);
  }

  getStrategyCandidates(limit = 100, now = Date.now()) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const candidates = [];
    const summary = { active: 0, monitoring: 0, waiting: 0, signaled: 0, ineligible: 0 };

    for (const [mint, state] of this.states) {
      const token = this.tokenRegistry?.getToken?.(mint);
      if (token && token.is_active === 0) continue;
      if (!state.lastProcessedTs) continue;
      let stage = state.stage;
      let waitReason = state.waitReason;
      if (state.candidate && now > state.candidate.expiresAt) {
        stage = 'monitoring';
        waitReason = 'rebound window expired; waiting for a new drop episode';
      }
      summary.active++;
      if (Object.prototype.hasOwnProperty.call(summary, stage)) summary[stage]++;
      const view = this._candidateView(state.candidate, state.latestPrice);
      const migrationTime = normalizeUnixMs(token?.migration_time);
      candidates.push({
        mint,
        symbol: state.symbol || token?.symbol || null,
        updatedAt: state.lastProcessedTs,
        ageMs: migrationTime ? Math.max(0, now - migrationTime) : null,
        stage,
        latestPrice: state.latestPrice,
        rollingHigh: state.rollingHigh,
        rollingDropPct: round(state.rollingDropPct),
        peakPrice: view.peakPrice ?? null,
        lowPrice: view.lowPrice ?? null,
        candidateDropPct: round(view.dropPct),
        reboundPct: round(view.reboundPct),
        dropStartedAt: view.dropStartedAt ?? null,
        waitUntil: view.waitUntil ?? null,
        lastSignalTs: state.lastSignalTs,
        lastSignal: state.lastSignal,
        fdv: finite(token?.fdv),
        liquidity: finite(token?.liquidity),
        waitReason,
      });
    }

    const rank = { signaled: 4, waiting: 3, ineligible: 2, monitoring: 1 };
    candidates.sort((a, b) =>
      ((rank[b.stage] || 0) - (rank[a.stage] || 0)) ||
      (b.updatedAt - a.updatedAt));
    return {
      mode: this.entryMode,
      now,
      thresholds: {
        dropWindowMs: this.dropWindowMs,
        dropMinPct: this.dropMinPct,
        dropMaxPct: this.dropMaxPct,
        reboundMinPct: this.reboundMinPct,
        reboundMaxPct: this.reboundMaxPct,
        reboundTimeoutMs: this.reboundTimeoutMs,
        minFdvUsd: this.minFdvUsd,
        maxFdvUsd: this.maxFdvUsd,
        minLiquidityUsd: this.minLiquidityUsd,
        maxTokenAgeMs: this.maxTokenAgeMs,
        trailingActivatePct: config.strategy.trailingActivatePct,
        trailingDrawdownPct: config.strategy.trailingDrawdownPct,
        fastTakeProfitPct: config.strategy.fastTakeProfitPct,
        fastTakeProfitWindowMs: config.strategy.fastTakeProfitWindowMs,
        lossCheckAtMs: config.strategy.lossCheckAtMs,
        maxHoldMs: config.strategy.maxHoldMs,
      },
      summary,
      candidates: candidates.slice(0, safeLimit),
    };
  }
}

module.exports = DropReboundTracker;
