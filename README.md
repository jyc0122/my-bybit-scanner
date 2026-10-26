# Bybit EMA Touch Scanner

这是从本机 cTrader scanner 独立复刻出的 Bybit 只读行情扫描器。原项目 `E:\ctradermcp\site` 不会被修改；本版本默认监听另一个端口 `8788`。

扫描逻辑：

- 日线最近两根 K 线都不能触碰 `EMA21`（触碰定义为 `Low <= EMA <= High`）
- 最新日线收盘价在 `EMA21` 上方为多头，在下方为空头
- `15m`、`30m`、`1H`、`2H`、`4H` 任意一个周期最近 3 根 K 线触碰 `EMA144` 或 `EMA169`
- 触碰周期的最新收盘价还必须满足方向条件：日线多头时低于该周期 `EMA21`，日线空头时高于该周期 `EMA21`
- 只使用已经收盘的 K 线，所有未收盘 K 线都会被过滤
- 数据来自 Bybit V5 公共行情接口，不需要 API Key，也不会调用交易接口

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

容器内会自动设置 `HOST=0.0.0.0`。部署平台的启动命令也可以直接使用 `npm start`，并将 `HOST` 设置为 `0.0.0.0`。
