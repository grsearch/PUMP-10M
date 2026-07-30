# Dump Sniper

## Pump.fun Graduation Discovery

The service discovers successful Pump.fun graduations without a webhook:

- Helius WebSocket logs provide the low-latency path; the migration wallet is polled every 5 seconds to fill gaps.
- A transaction is accepted only when it contains the official Pump `migrate` discriminator and targets the official PumpSwap program.
- Mint, pool, vaults, chain `blockTime`, slot, and signature are read from the confirmed transaction and saved in `tokens`.
- All token sources use the same market thresholds: FDV `$20,000-$1,000,000` and liquidity at least `$3,000`.
- Pump graduation admission checks only FDV and liquidity. It records the confirmed migration time and does not request or filter on mint creation age.
- Passing discovery only adds the token to monitoring. The Activity Flow buy strategy remains unchanged.

Configuration is under `PUMP_DISCOVERY_*` in `.env.example`. Set `PUMP_DISCOVERY_ENABLED=false` to disable it.

Monitoring-list FDV, LP, price, and 24h volume are refreshed every minute through
the batched DEX Screener token endpoint, with Birdeye as a fallback. The dashboard
shows the age and source of the last successful market refresh. Webhooks may send
`migrationTime`/`migration_time` (seconds, milliseconds, or ISO time); when an
older webhook row has no migration time, the selected DEX pair creation time is
used to backfill its migration AGE even when that pair does not yet expose complete
FDV/LP data. Legacy `WATCHDOG_CHECK_INTERVAL_MS` values above one minute are clamped
to `60000`.

Solana / Pump.fun 短线交易机器人。当前默认买入策略是 **已收盘 1 秒 RSI(7) 从 ≤30 上穿 >30，并且触发时实时 1 秒 RSI(7) ≤50**。回调/上涨阶段成交量、EMA20 和60秒总成交量只记录、不参与过滤；每个代币只允许成功开仓一次，默认仓位为 `0.2 SOL`。

## 当前买入策略

程序用真实成交的收盘价计算 1 秒 RSI，并按以下顺序判断：

- RSI 周期为 `7`，只用已经收盘的 1 秒 K 线确认信号。
- 上一根已收盘 RSI `<=30`、最新已收盘 RSI `>30`，构成从下向上突破 30。
- 触发交易到达时，实时 1 秒 RSI(7) 必须 `<=50`；实时 RSI 缺失或超过50时拒绝。
- 回调/上涨阶段平均成交量和 1 秒 EMA20 最近20秒斜率继续记录，但不参与买入过滤。
- 信号收盘前 `60 秒`真实买卖总成交量继续记录，但不参与买入过滤。
- 收盘信号得到确认后立即进入现有实盘下单链路，不增加额外等待。
- 每次 RSI 上穿买点都会写入 `RSI_BUY_POINT` 观测事件，保存实时RSI、回调/上涨量比、EMA20斜率、60秒主动买卖比、Holder及其相对上次买点变化、LP、FDV、AGE等字段；这些扩展字段除实时RSI上限外均不参与买入判断。

默认入口日志应显示：

```text
Entry: closed RSI(7,1s) cross above 30, live RSI<=50; pullback volume, EMA20, and 60s volume are observation-only
Legacy dumpSignal: suppressed
[main] ActivityFlow enabled: mode=RSI_CROSS_1S ... immediate-confirmation ...
```

## 当前卖出策略

- 移动止盈：每个仓位独立计算；上涨 `10%` 激活，从各自最高点回撤 `5%` 卖出。
- RSI 卖出：移动止盈尚未激活时，实时 1 秒 RSI `>80`，或从 `>=70` 下穿 `<70` 时卖出；某笔仓位一旦先激活移动止盈，该仓位永久屏蔽这两条 RSI 卖出。
- 固定止损关闭。
- FDV 跌破 `$20,000` 的强制卖出关闭。
- 最长持仓 `30 秒`：每笔仓位到时立即卖出。
- 代币迁移 AGE 达到 `15 分钟`：全部未平仓仓位逐笔立即卖出，全部确认成交后移出监控。
- 每个代币只允许一次成功开仓；不加仓，卖出后也不再重新买入。该限制从持久化的 `positions` 记录恢复，服务重启不会重置。
- 买入处理中仍使用瞬时防重复锁，执行失败保护也继续独立生效；二者都不是卖后冷静期。

## 监控列表过滤

TokenWatchdog 默认每 1 分钟巡检一次 FDV 和 LP：

- FDV 必须在 `$20,000 ~ $1,000,000`
- Birdeye LP 必须 `>= $3,000`
- 24h 交易量必须 `>= $5,000`
- AGE 从 Pump 迁移时间开始计算；达到 `15 分钟`时，无持仓代币直接移除，有持仓代币确认卖出后移除
- 迁移时间未知时 AGE 显示未知，不使用 mint 创建时间或添加时间猜测
- 监控列表上限默认 `500` 个；只有新增代币后超过该上限才会触发驱逐

## 数据留存

默认开启 `SWAP_EVENT_LOG_ENABLED=true`。程序会把每一笔已解析的监控币实时 swap 写入 SQLite 的 `swap_events` 表，后续可以基于这张表离线重算窗口并回测阈值。

### 10-second failed-bounce exit

Each position is evaluated once on the first fresh live 1-second RSI observation
after 10 seconds. `NO_RECOVERY_10S` sells only when trailing has not armed,
current PnL is at or below `-1%`, the post-stabilization maximum favorable
excursion relative to the real fill never exceeded `+1%`, and live RSI(7) is
at or below `50`. Ignoring stabilization prices prevents the bot's own AMM
price impact from creating a false peak. The timer, real fill price, MFE, and
evaluation state are independent for each same-mint leg.

## Strategy Lab

默认开启 `STRATEGY_LAB_ENABLED=true`。程序会基于实时 `swapParsed` 成交流写入一套特征数据库：

- `token_snapshots`：最近活跃代币的每秒特征快照，包含 FDV、LP、AGE、买卖量/次数、唯一钱包、新/老买家、最大/平均/中位买单、BUY/SELL streak、TPS、价格变化、波动率、LP/FDV 变化、机器人延迟，以及延迟回填的 30s/60s/180s 未来收益标签。
- `token_candles`：15 秒和 1 分钟 K 线，包含 OHLC、买卖量、交易次数和唯一买卖钱包。
- `token_events`：首次突破 1 分钟高点、资金流转正、Buy Burst、TPS 翻倍、Smart Wallet 买入、LP 变化和 FDV 档位突破等事件。
- `bot_latency_events`：买入链路的 detect / decision / send / confirm 延迟拆分。

成交事件默认经过 `SwapSanitizer`：零成交量事件会被拒绝；CPI/余额回退产生的归一化价格、瞬时百倍跳价会使用最近可信池价或新鲜市场价校正。真实成交量仍会保留；暂时无法确定价格时只记录成交量，不生成价格 Tick。新数据写入 `data_quality_version=2`，原有历史行保持版本 1，便于明确区分修复前后的数据。

默认只给最近有成交的代币持续快照，避免全监控列表每秒刷库影响交易延迟。若要强制整个监控列表每秒记录，设置 `STRATEGY_LAB_SNAPSHOT_ALL_ACTIVE=true`。

导出策略数据集：

```bash
npm run export:strategy -- --hours 168
npm run export:strategy -- --hours 0 --all
```

默认只导出 `data_quality_version>=4`、价格可信且 30s/60s/180s 标签完整的样本。导出前会拒绝未确认的 2x 价格尖峰；超过 120 秒的成交断档会切断价格序列，30 秒内被后续 3 笔可信成交确认的新价格会作为真实跳变保留。需要导出未打标签快照时可加 `--include-unlabeled`。`--all` 会校验导出字段数确实等于数据库全部特征字段。只有明确研究旧数据时才使用 `--min-quality-version 0`。

## 15 秒策略回测

积累真实 `swap_events` 后运行：

```bash
npm run backtest:flow-candles
```

回测默认读取最近 7 天，按当前买入、资金流卖出、固定止盈、移动止盈和固定止损规则模拟，并扣除 `2%` 往返执行成本。可通过 `BT_SINCE_MS`、`BT_UNTIL_MS`、`BT_ROUND_TRIP_COST_PCT`、`BT_MIN_VOLUME_1M_SOL` 和 `BT_MIN_TRADES_1M` 调整研究范围。

至少积累 3 到 7 天、`10,000` 笔以上有效 swap 和 30 笔以上已平仓模拟交易后，再判断胜率和收益；样本更少时只能视为探索性结果。

## 关键配置

```env
ACTIVITY_FLOW_ENABLED=true
ACTIVITY_FLOW_REPLACE_DUMP_SIGNAL=true
ACTIVITY_FLOW_COOLDOWN_MS=0
ACTIVITY_FLOW_MAX_SIGNAL_AGE_MS=5000

FLOW_REVERSAL_EXIT_ENABLED=false
TAKE_PROFIT_PCT=0
EMERGENCY_STOP_LOSS_PCT=0
NO_BOUNCE_EXIT_ENABLED=false
STABILIZATION_EMERGENCY_DRAWDOWN_PCT=0

REBUY_COOLDOWN_MS=0
MIN_FDV_USD=20000
MAX_FDV_USD=1000000
MIN_LIQUIDITY_USD=3000
WATCHDOG_CHECK_INTERVAL_MS=60000
WATCHDOG_MARKET_STALE_MS=180000
MAX_WATCHED_TOKENS=500

BUY_MIN_PRIORITY_FEE_LAMPORTS=500000
BUY_CAP_PRIORITY_FEE_LAMPORTS=500000
BUY_MAX_PRIORITY_FEE_LAMPORTS=500000
MAX_PRIORITY_FEE_LAMPORTS=500000
COMPUTE_UNIT_LIMIT=250000
SWAP_EVENT_LOG_ENABLED=true
STRATEGY_LAB_ENABLED=true
STRATEGY_LAB_SNAPSHOT_INTERVAL_MS=1000
STRATEGY_LAB_LABEL_ENABLED=true
STRATEGY_LAB_SNAPSHOT_ALL_ACTIVE=false
STRATEGY_LAB_BUY_BURST_THRESHOLD=10
STRATEGY_LAB_TPS_DOUBLE_MIN=5
STRATEGY_LAB_LP_CHANGE_PCT=10
```

上线前核对 `.env` 已填好 Helius、Birdeye 和钱包密钥，并确认启动日志显示 `RSI_CROSS_1S`。
