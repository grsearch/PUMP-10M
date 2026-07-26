'use strict';

/**
 * AlertChecker
 * ============
 * 业务规则告警。每 5 秒跑一次，检查特定的"应该发生但没发生"或"不应该发生但发生了"
 * 的情况，触发 monitor.fireAlert。
 *
 * 这一层的职责是把"指标异常"翻译成人能看懂的告警。
 */

const CHECK_INTERVAL_MS = 5_000;

class AlertChecker {
  constructor({ monitor, tickStream, executor, positionManager, tokenRegistry, config }) {
    this.monitor = monitor;
    this.tickStream = tickStream;
    this.executor = executor;
    this.positionManager = positionManager;
    this.tokenRegistry = tokenRegistry;
    this.config = config;

    this._timer = null;

    this._lastBuyFail = 0;
    this._lastSellFail = 0;
    this._lastRegionReconnectAt = new Map();
  }

  start() {
    this._timer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  _check() {
    try {
      this._checkTickStream();
      this._checkExecutorFailures();
      this._checkParseErrorRate();
      // v3.17.9: BUY 链上失败 / CU 接近上限 / reconcile watchdog 触发
      this._checkBuyChainFailures();
    } catch (err) {
      this.monitor.recordError('AlertChecker', err);
    }
  }

  /**
   * v3.17.9: 关键的 BUY 链上失败监控
   *
   * 区分两种情况:
   * 1. CU 接近上限(≥90% 利用率):告警 warn 级别 — 提示"还有余量但 BUY 即将开始爆"
   * 2. 链上 BUY 失败(ProgramFailedToComplete):error 级别 — 已经在烧 fee 但没买到
   * 3. reconcile watchdog 触发(60s 内 reconcile 没完成):critical — 通常是 RPC 问题
   */
  _checkBuyChainFailures() {
    const cuNearLimit = this.monitor.getCounter('PositionManager.cuNearLimit') || 0;
    const buyChainFail = this.monitor.getCounter('PositionManager.buyChainFail') || 0;
    const reconcileWatchdog = this.monitor.getCounter('PositionManager.reconcileWatchdog') || 0;

    // CU 接近上限 — 还能成功但下一笔可能爆
    if (cuNearLimit > 0) {
      this.monitor.fireAlert(
        'executor.cu_near_limit',
        'warn',
        `${cuNearLimit} 笔 BUY CU 利用率 ≥90%,下一笔可能 BUY_CHAIN_FAILED。立刻调大 COMPUTE_UNIT_LIMIT (推荐 +30K)`,
        { cuNearLimit },
      );
    } else {
      this.monitor.clearAlert('executor.cu_near_limit');
    }

    // BUY 链上失败 — 已经烧 fee 但没买到 token
    if (buyChainFail > 0) {
      this.monitor.fireAlert(
        'executor.buy_chain_failed',
        'error',
        `${buyChainFail} 笔 BUY ProgramFailedToComplete,fee 已烧但 token 没买到。立刻调大 COMPUTE_UNIT_LIMIT`,
        { buyChainFail },
      );
    } else {
      this.monitor.clearAlert('executor.buy_chain_failed');
    }

    // reconcile watchdog 触发 — 异常的 reconcile 未执行场景
    if (reconcileWatchdog > 0) {
      this.monitor.fireAlert(
        'positions.reconcile_watchdog',
        'critical',
        `${reconcileWatchdog} 笔 position 60s 内 reconcile 未完成被 watchdog 强关。通常是 Helius RPC 异常,检查网络`,
        { reconcileWatchdog },
      );
    } else {
      this.monitor.clearAlert('positions.reconcile_watchdog');
    }
  }

  /**
   * 窄过滤交易流的“无成交”不等于“断流”。连接健康由 RegionStream 在
   * 同一条 gRPC 订阅上的 ping/pong 和连接状态给出；只有该信号失活才告警。
   */
  _checkTickStream() {
    const watching = this.tokenRegistry.getActiveMintSet().size;
    // 清理旧版本基于成交数量产生的误报告警。
    this.monitor.clearAlert('tickstream.no_traffic');
    if (watching === 0) {
      this.monitor.clearAlert('tickstream.stream_unhealthy');
      return;
    }

    const now = Date.now();
    const regions = (this.tickStream?.regions || []).filter(
      (region) => region.label?.startsWith('LS-') || region.label?.startsWith('JUP-'),
    );
    const states = regions.map((region) => {
      if (typeof region.getHealth === 'function') return region.getHealth(now);
      const expected = Boolean(region.shouldRun && region._currentMints?.length > 0);
      return {
        label: region.label,
        expected,
        connected: Boolean(region.connected),
        healthy: !expected || Boolean(region.connected),
        activityAgeMs: null,
        lastPongAgeMs: null,
        lastTxAgeMs: null,
        watchedMints: region._currentMints?.length || 0,
      };
    });
    const expectedStates = states.filter((state) => state.expected);
    const unhealthy = expectedStates.filter((state) => !state.healthy);

    this.monitor.set('TickStream.expectedRegions', expectedStates.length, 'TickStream');
    this.monitor.set(
      'TickStream.healthyRegions',
      expectedStates.length - unhealthy.length,
      'TickStream',
    );

    if (unhealthy.length === 0) {
      this.monitor.clearAlert('tickstream.stream_unhealthy');
      return;
    }

    const unhealthyLabels = unhealthy.map((state) => state.label);
    const severity = unhealthy.length === expectedStates.length ? 'error' : 'warn';
    this.monitor.fireAlert(
      'tickstream.stream_unhealthy',
      severity,
      `LaserStream 订阅异常: ${unhealthyLabels.join(', ')}；正在自动重连`,
      {
        watching,
        healthy_regions: expectedStates.length - unhealthy.length,
        expected_regions: expectedStates.length,
        regions: unhealthy.map((state) => ({
          label: state.label,
          connected: state.connected,
          last_activity_seconds_ago:
            state.activityAgeMs == null ? null : Math.round(state.activityAgeMs / 1000),
          last_pong_seconds_ago:
            state.lastPongAgeMs == null ? null : Math.round(state.lastPongAgeMs / 1000),
          last_matching_tx_seconds_ago:
            state.lastTxAgeMs == null ? null : Math.round(state.lastTxAgeMs / 1000),
        })),
      },
    );

    for (const state of unhealthy) {
      const region = regions.find((candidate) => candidate.label === state.label);
      const lastReconnectAt = this._lastRegionReconnectAt.get(state.label) || 0;
      if (
        region &&
        now - lastReconnectAt >= 60_000 &&
        typeof region._scheduleReconnect === 'function'
      ) {
        this._lastRegionReconnectAt.set(state.label, now);
        try {
          region.reconnectAttempts = 0;
          region._scheduleReconnect();
          this.monitor.inc('TickStream.forceReconnectUnhealthy', 1, 'TickStream');
        } catch (err) {
          console.warn(`[AlertChecker] reconnect ${state.label} failed: ${err.message}`);
        }
      }
    }
  }

  /**
   * Executor：连续 3 次 BUY 失败 / SELL 失败 → 告警
   */
  _checkExecutorFailures() {
    const buyFail = this.monitor.getCounter('Executor.buyFail');
    const buySuccess = this.monitor.getCounter('Executor.buySuccess');
    const sellFail = this.monitor.getCounter('Executor.sellFail');
    const sellSuccess = this.monitor.getCounter('Executor.sellSuccess');

    // 连续失败 = (失败次数 - 上次成功后的失败次数) ≥ 3
    // 这里用更简单的近似：最近 5 笔交易里失败 ≥ 3
    const recentBuy = buyFail + buySuccess;
    if (recentBuy >= 3) {
      const failRate = buyFail / recentBuy;
      if (failRate >= 0.6) {
        this.monitor.fireAlert(
          'executor.buy_failures',
          'error',
          `BUY 失败率高: ${buyFail}/${recentBuy} (${(failRate * 100).toFixed(0)}%)`,
          { buyFail, buySuccess },
        );
      } else {
        this.monitor.clearAlert('executor.buy_failures');
      }
    }
    const recentSell = sellFail + sellSuccess;
    if (recentSell >= 3) {
      const failRate = sellFail / recentSell;
      if (failRate >= 0.6) {
        this.monitor.fireAlert(
          'executor.sell_failures',
          'critical',
          `SELL 失败率高: ${sellFail}/${recentSell} (${(failRate * 100).toFixed(0)}%) - 资金可能卡住`,
          { sellFail, sellSuccess },
        );
      } else {
        this.monitor.clearAlert('executor.sell_failures');
      }
    }
  }

  /**
   * DumpDetector 解析错误率 > 10% → 告警
   */
  _checkParseErrorRate() {
    const total = this.monitor.getCounter('DumpDetector.txParsed');
    const errors = this.monitor.getCounter('DumpDetector.parseErrors');
    if (total < 50) return; // 样本不足
    const rate = errors / total;
    if (rate > 0.1) {
      this.monitor.fireAlert(
        'detector.high_parse_error_rate',
        'warn',
        `DumpDetector 解析错误率 ${(rate * 100).toFixed(1)}% (${errors}/${total})`,
        { errors, total },
      );
    } else {
      this.monitor.clearAlert('detector.high_parse_error_rate');
    }
  }
}

module.exports = AlertChecker;
