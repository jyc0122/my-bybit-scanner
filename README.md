# Multi-Source LRC25 / LRC6 Scanner

这是从本机 cTrader scanner 独立复刻出的只读行情扫描器，可在 dashboard 中切换 `Bybit`、`Binance USDⓈ-M Futures` 与 `OKX USDT Perpetual`。原项目 `E:\ctradermcp\site` 不会被修改；本版本默认监听另一个端口 `8788`。

扫描逻辑：

- 日线最近两根 K 线都不能触碰 `EMA21`（触碰定义为 `Low <= EMA <= High`）
- 最新日线收盘价在 `EMA21` 上方为多头，在下方为空头
- 扫描日线以下的 `15m`、`1H`、`4H`，分别计算 `LRC25` 与 `LRC6` 角度（收盘价、窗口最高最低价标准化）
- 日线空头时，同一低周期必须同时满足 `LRC25 < 0°` 与 `LRC6 > 0°`
- 日线多头时，同一低周期必须同时满足 `LRC25 > 0°` 与 `LRC6 < 0°`
- 不再使用低周期 EMA21 穿越路径条件
- 如果多个低周期同时符合，只显示最大的那个周期（`4H > 1H > 15m`）
- 对已经入选的品种，在其最大符合周期中比较当前与上一根已收盘 K 线的 `LRC6`：方向保持不变且角度绝对值变小时，额外列入 dashboard 的“LRC6 减弱”区域
- 自动化可把全量扫描结果作为当日基线传给 `POST /api/weakening-check`；该轻量接口只读取每个候选的已选周期，不重复读取日线或其他周期
- 扫描结果默认按最新日线收盘价与日线 `EMA21` 的绝对百分比距离，从近到远排列
- 只使用已经收盘的 K 线，所有未收盘 K 线都会被过滤
- dashboard 不再绘制日线 K 线图，结果详情只保留筛选所需指标
- 数据来自 Bybit V5、Binance USDⓈ-M Futures 或 OKX 公共行情接口，不需要 API Key，也不会调用交易接口

## 数据源

- `Bybit`：使用 `api.bybit.com/v5/market/*`
- `Binance Futures`：使用 `fapi.binance.com/fapi/v1/*`
- `OKX Perpetual`：使用 `openapi.okx.com/api/v5/*`，日线采用 UTC 日界线 `1Dutc`
- Binance 模式会读取官方 `exchangeInfo`，只扫描配置清单中当前状态为 `TRADING`、合约类型为 `PERPETUAL`、报价资产为 `USDT` 的品种
- OKX 模式会读取官方 `SWAP` 合约清单，只扫描当前 `live`、以 USDT 结算的永续合约；常见的千倍币命名会自动映射到 OKX 标的
- 当前数据源不存在的配置品种会被计为“不可用并跳过”，不会被误记为扫描失败
- 三个数据源使用相同的日线 EMA21、LRC25/LRC6、最大符合周期和日线距离排序规则

## 交易对配置

编辑 `config/symbols.json`。当前清单已经按 `TradFi & Commodities` 和 `Crypto` 分组；原始输入保存在 `config/requested-symbols.txt`，无法在 Bybit 当前 linear Trading 清单中匹配的项目记录在 `config/unavailable-symbols.json`。

本次用户清单共 156 项，去重后 154 项；当前启用 147 个 Bybit 合约（Crypto 88、TradFi & Commodities 59），另有 7 项未找到可交易合约并保留在审计文件中。

```json
{
  "market": "linear",
  "groups": [
    {
      "name": "My List",
      "symbols": ["BTCUSDT", "ETHUSDT"]
    }
  ]
}
```

`market` 支持 `linear`、`inverse`、`spot`；分组名用于 dashboard 左侧筛选。TradingView 的 `.P` 后缀会自动移除。也支持旧版 `symbols` 数组格式。

验证原始交易对清单是否仍在 Bybit Trading 状态：

```powershell
node .\scripts\validate-symbols.mjs
```

连同本地服务执行完整端到端扫描：

```powershell
node .\scripts\validate-symbols.mjs --scan
```

对 Binance 数据源执行端到端扫描：

```powershell
node .\scripts\validate-symbols.mjs --scan --source=binance
```

对 OKX 数据源执行端到端扫描：

```powershell
node .\scripts\validate-symbols.mjs --scan --source=okx
```

只复查既有候选的 LRC6 减弱（不会重新做全量扫描）：

```json
POST /api/weakening-check
{
  "source": "okx",
  "candidates": [
    { "symbol": "BTCUSDT", "side": "short", "selectedTimeframe": "4H" }
  ]
}
```

接口返回异步任务 `id`，继续通过 `GET /api/scan/{id}` 轮询；`results` 只包含当前已出现 LRC6 减弱的候选。

## 启动

电脑重启后，直接双击本目录的 `打开Bybit Scanner.cmd`。脚本会自动：

1. 检查 Scanner 是否已经运行；
2. 未运行时在后台启动服务；
3. 等待服务就绪后打开默认浏览器。

服务日志保存在 `scanner-site/logs`。

也可以在本目录手动以前台方式运行：

```powershell
.\start-scanner.ps1
```

然后打开 [http://127.0.0.1:8788](http://127.0.0.1:8788)。也可以在 Node.js 20+ 环境运行 `npm start`。

## 验证

```powershell
.\test-scanner.ps1
```

可选环境变量：

- `PORT`：本地网页端口，默认 `8788`
- `HOST`：监听地址，默认 `127.0.0.1`；容器或云端运行时设为 `0.0.0.0`
- `BYBIT_API_BASE`：Bybit API 根地址，默认 `https://api.bybit.com`
- `BINANCE_API_BASE`：Binance USDⓈ-M Futures API 根地址，默认 `https://fapi.binance.com`
- `OKX_API_BASE`：OKX API 根地址，默认 `https://openapi.okx.com`
- `BYBIT_SYMBOLS_FILE`：自定义交易对 JSON 文件绝对路径
- `BYBIT_SCAN_CONCURRENCY`：并发品种数，默认 `4`，最大 `8`
- `BYBIT_REQUEST_TIMEOUT_MS`：单次请求超时，默认 `20000`
- `BYBIT_REQUEST_GAP_MS`：Bybit 请求起始间隔，默认 `125` 毫秒
- `BYBIT_RATE_LIMIT_RETRIES`：遇到 `10006`/HTTP 429 时的最大重试次数，默认 `6`

服务只绑定 `127.0.0.1`，不会暴露到局域网。

## Docker / 云端运行

项目包含独立的 `Dockerfile`。本地构建并运行：

```powershell
docker build -t my-bybit-scanner .
docker run --rm -p 8788:8788 my-bybit-scanner
```

容器内会自动设置 `HOST=0.0.0.0`。部署平台的启动命令也可以直接使用 `npm start`，并将 `HOST` 设置为 `0.0.0.0`。云端网络策略需要允许所选数据源域名：`api.bybit.com`、`fapi.binance.com`、`openapi.okx.com`。

## GitHub Actions 自动监控

`.github/workflows/okx-hourly.yml` 在 GitHub 云端每小时整点运行，不要求本机开机：

- 每次运行都执行 OKX 全量扫描，并把最新状态保存到专用 `automation-state` 分支；
- 只有符合规则且 LRC6 数值减弱的交易对会进入通知，普通候选、失败项和“无减弱”状态不会发送；
- 减弱结果会追加到仓库的 `OKX LRC6 减弱提醒` Issue；
- 配置 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 两个 Repository Actions Secrets 后，同一结果也会发送到 Telegram；未配置时会安全跳过 Telegram，不影响扫描；
- 可在 Actions 页面使用 `Run workflow` 随时手动执行一次完整扫描。

Telegram 凭据只能存放在仓库的 `Settings → Secrets and variables → Actions`，不要写入代码或 workflow 文件。Telegram 消息按长度自动分段，并且只列出减弱区域的交易对。
