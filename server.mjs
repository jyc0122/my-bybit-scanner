import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE_ROOT = fileURLToPath(new URL("./", import.meta.url));
const PUBLIC_ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const SYMBOLS_FILE = process.env.BYBIT_SYMBOLS_FILE || join(SITE_ROOT, "config", "symbols.json");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8788);
const API_BASE = String(process.env.BYBIT_API_BASE || "https://api.bybit.com").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.BYBIT_REQUEST_TIMEOUT_MS || 20_000);
const SCAN_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BYBIT_SCAN_CONCURRENCY || 4)));
const REQUEST_GAP_MS = Math.max(50, Number(process.env.BYBIT_REQUEST_GAP_MS || 125));
const RATE_LIMIT_RETRIES = Math.max(0, Math.min(8, Number(process.env.BYBIT_RATE_LIMIT_RETRIES || 6)));
const jobs = new Map();
let nextRequestAt = 0;
let requestGate = Promise.resolve();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function cleanError(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRequestSlot() {
  let release;
  const previous = requestGate;
  requestGate = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) await sleep(delay);
    nextRequestAt = Date.now() + REQUEST_GAP_MS;
  } finally {
    release();
  }
}

async function bybitGet(pathname, params = {}) {
  const url = new URL(pathname, `${API_BASE}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    await waitForRequestSlot();
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "bybit-lrc-scanner/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch {
      if (!response.ok) throw new Error(`Bybit HTTP ${response.status}: ${text.slice(0, 240) || response.statusText}`);
      throw new Error("Bybit returned invalid JSON");
    }

    const rateLimited = response.status === 429 || Number(payload?.retCode) === 10006;
    if (rateLimited && attempt < RATE_LIMIT_RETRIES) {
      const resetAt = Number(response.headers.get("x-bapi-limit-reset-timestamp"));
      const headerDelay = Number.isFinite(resetAt) && resetAt > Date.now() ? resetAt - Date.now() + 100 : 0;
      const backoff = Math.min(10_000, 500 * (2 ** attempt));
      const delay = Math.max(headerDelay, backoff);
      nextRequestAt = Math.max(nextRequestAt, Date.now() + delay);
      await sleep(delay);
      continue;
    }

    if (!response.ok) throw new Error(`Bybit HTTP ${response.status}: ${text.slice(0, 240) || response.statusText}`);
    if (Number(payload?.retCode) !== 0) throw new Error(`Bybit ${payload?.retCode ?? "error"}: ${payload?.retMsg || "request failed"}`);

    const remaining = Number(response.headers.get("x-bapi-limit-status"));
    const resetAt = Number(response.headers.get("x-bapi-limit-reset-timestamp"));
    if (Number.isFinite(remaining) && remaining <= 1 && Number.isFinite(resetAt) && resetAt > Date.now()) {
      nextRequestAt = Math.max(nextRequestAt, resetAt + 100);
    }
    return payload;
  }
  throw new Error("Bybit rate limit retry budget exhausted");
}

function normalizeConfiguredSymbol(item, index) {
  const source = typeof item === "string" ? { symbol: item } : item;
  if (!source || typeof source !== "object") throw new Error(`symbols[${index}] must be a string or object`);
  const symbol = String(source.symbol || "").trim().replace(/\.P$/i, "").toUpperCase();
  if (!/^[A-Z0-9-]{3,40}$/.test(symbol)) throw new Error(`symbols[${index}] has invalid symbol: ${symbol || "(empty)"}`);
  const market = String(source.market || "linear").trim().toLowerCase();
  if (!["linear", "inverse", "spot"].includes(market)) throw new Error(`${symbol} has unsupported market: ${market}`);
  return {
    symbol,
    name: String(source.name || symbol).trim(),
    category: String(source.group || (market === "linear" ? "USDT Perpetual" : market)).trim(),
    market,
  };
}

function expandConfiguredSymbols(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.symbols)) return raw.symbols;
  if (Array.isArray(raw?.groups)) {
    return raw.groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.symbols)) {
        throw new Error("Each config group must contain a symbols array");
      }
      return group.symbols.map((item) => typeof item === "string"
        ? { symbol: item, group: group.name, market: group.market || raw.market }
        : { ...item, group: item.group || group.name, market: item.market || group.market || raw.market });
    });
  }
  throw new Error("symbols.json must contain a symbols array or groups array");
}

export async function loadUniverse(filePath = SYMBOLS_FILE) {
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  const source = expandConfiguredSymbols(raw);
  const seen = new Set();
  const symbols = source.map(normalizeConfiguredSymbol).filter((item) => !seen.has(item.symbol) && seen.add(item.symbol));
  if (!symbols.length) throw new Error("symbols.json is empty; add at least one Bybit trading pair");
  return symbols;
}

function intervalDuration(interval) {
  if (interval === "D") return 86_400_000;
  return Number(interval) * 60_000;
}

export function normalizeKlines(payload, interval, now = Date.now()) {
  const duration = intervalDuration(interval);
  const rows = payload?.result?.list;
  if (!Array.isArray(rows)) throw new Error("Bybit kline response does not contain result.list");
  return rows
    .filter((row) => Array.isArray(row) && row.length >= 7)
    .map((row) => ({
      t: new Date(Number(row[0])).toISOString().slice(0, 10),
      ts: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
      turnover: Number(row[6]),
    }))
    .filter((bar) => [bar.ts, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite) && bar.ts + duration <= now)
    .sort((a, b) => a.ts - b.ts)
    .filter((bar, index, bars) => index === bars.length - 1 || bar.ts !== bars[index + 1].ts);
}

function ema(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  const alpha = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = values[index] * alpha + current * (1 - alpha);
    output[index] = current;
  }
  return output;
}

function enrichDailyBars(bars) {
  const ema21 = ema(bars.map((bar) => bar.c), 21);
  return bars.map((bar, index) => ({
    ...bar,
    e21: ema21[index],
  }));
}

function candleTouches(bar, value) {
  return Number.isFinite(value) && bar.l <= value && bar.h >= value;
}

function evaluateTouchWindow(bars, timeframe) {
  if (bars.length < 171) {
    throw new Error(`Only ${bars.length} closed ${timeframe} bars returned; 171 are required`);
  }
  const closes = bars.map((bar) => bar.c);
  const ema144 = ema(closes, 144);
  const ema169 = ema(closes, 169);
  const enriched = bars.map((bar, index) => ({ ...bar, e144: ema144[index], e169: ema169[index] }));
  const recent = enriched.slice(-3);
  const touches = [];
  recent.forEach((bar, index) => {
    for (const period of [144, 169]) {
      const value = bar[`e${period}`];
      if (candleTouches(bar, value)) {
        touches.push({
          period,
          barsAgo: recent.length - 1 - index,
          at: new Date(bar.ts).toISOString().replace("T", " ").slice(0, 16) + " UTC",
          value,
        });
      }
    }
  });
  const latestTouch = touches.reduce((latest, touch) => !latest || touch.barsAgo < latest.barsAgo ? touch : latest, null);
  return {
    timeframe,
    passed: touches.length > 0,
    touchedPeriods: [...new Set(touches.map((touch) => touch.period))],
    lastTouchBarsAgo: latestTouch?.barsAgo ?? null,
    lastTouchAt: latestTouch?.at ?? null,
    asOf: new Date(recent.at(-1).ts).toISOString().replace("T", " ").slice(0, 16) + " UTC",
  };
}

export function analyzeSymbol(symbol, dailyBars, m15Bars, m30Bars, h1Bars, h2Bars, h4Bars) {
  if (dailyBars.length < 22) throw new Error(`Only ${dailyBars.length} closed daily bars returned; 22 are required`);
  const enriched = enrichDailyBars(dailyBars);
  const last = enriched.at(-1);
  const previous = enriched.at(-2);
  const recentDaily = enriched.slice(-2);
  const dailyNoTouch = recentDaily.every((bar) => !candleTouches(bar, bar.e21));
  const dailySide = dailyNoTouch && last.c > last.e21
    ? "long"
    : dailyNoTouch && last.c < last.e21
      ? "short"
      : "neutral";
  const confirmations = [
    evaluateTouchWindow(m15Bars, "15m"),
    evaluateTouchWindow(m30Bars, "30m"),
    evaluateTouchWindow(h1Bars, "1H"),
    evaluateTouchWindow(h2Bars, "2H"),
    evaluateTouchWindow(h4Bars, "4H"),
  ];
  const confirmationPassed = confirmations.some((confirmation) => confirmation.passed);
  const side = dailySide !== "neutral" && confirmationPassed ? dailySide : "neutral";
  return {
    symbol: symbol.symbol,
    name: symbol.name,
    category: symbol.category,
    market: symbol.market,
    side,
    dailySide,
    close: last.c,
    changePct: previous ? (last.c / previous.c - 1) * 100 : 0,
    ema21: last.e21,
    emaDistancePct: (last.c / last.e21 - 1) * 100,
    dailyNoTouch,
    dailyBarsChecked: recentDaily.map((bar) => ({
      at: bar.t,
      touched: candleTouches(bar, bar.e21),
      ema21: bar.e21,
    })),
    confirmationPassed,
    confirmations,
    qualifyingTimeframes: confirmations.filter((item) => item.passed).map((item) => item.timeframe),
    asOf: last.t,
    bars: enriched.slice(-260),
  };
}

async function fetchKlines(symbol, interval, limit) {
  const payload = await bybitGet("/v5/market/kline", {
    category: symbol.market,
    symbol: symbol.symbol,
    interval,
    limit,
  });
  return normalizeKlines(payload, interval);
}

async function getTickerMap(symbols) {
  const markets = [...new Set(symbols.map((item) => item.market))];
  const map = new Map();
  await Promise.all(markets.map(async (market) => {
    const payload = await bybitGet("/v5/market/tickers", { category: market });
    for (const ticker of payload?.result?.list || []) map.set(`${market}:${ticker.symbol}`, ticker);
  }));
  return map;
}

async function runScan(job, categories) {
  try {
    const universe = await loadUniverse();
    const selected = categories?.length ? universe.filter((symbol) => categories.includes(symbol.category)) : universe;
    if (!selected.length) throw new Error("No configured symbols match the selected groups");
    job.status = "running";
    job.total = selected.length;
    job.startedAt = new Date().toISOString();
    const tickers = await getTickerMap(selected);
    let cursor = 0;
    const worker = async () => {
      while (cursor < selected.length) {
        const symbol = selected[cursor++];
        job.current = symbol.symbol;
        try {
          const [dailyBars, m15Bars, m30Bars, h1Bars, h2Bars, h4Bars] = await Promise.all([
            fetchKlines(symbol, "D", 260),
            fetchKlines(symbol, "15", 220),
            fetchKlines(symbol, "30", 220),
            fetchKlines(symbol, "60", 220),
            fetchKlines(symbol, "120", 220),
            fetchKlines(symbol, "240", 220),
          ]);
          const analysis = analyzeSymbol(symbol, dailyBars, m15Bars, m30Bars, h1Bars, h2Bars, h4Bars);
          const ticker = tickers.get(`${symbol.market}:${symbol.symbol}`);
          analysis.turnover24h = Number(ticker?.turnover24h || ticker?.turnover24H || 0);
          analysis.volume24h = Number(ticker?.volume24h || ticker?.volume24H || 0);
          job.scanned += 1;
          if (analysis.side !== "neutral") job.results.push(analysis);
        } catch (error) {
          job.scanned += 1;
          job.failed += 1;
          if (job.errors.length < 200) job.errors.push({ symbol: symbol.symbol, message: cleanError(error) });
        }
        job.results.sort((a, b) => Math.abs(a.emaDistancePct) - Math.abs(b.emaDistancePct));
        job.updatedAt = new Date().toISOString();
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, selected.length) }, worker));
    job.status = "complete";
    job.current = "";
    job.finishedAt = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.message = cleanError(error);
    job.finishedAt = new Date().toISOString();
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    scanned: job.scanned,
    failed: job.failed,
    current: job.current,
    results: job.results,
    errors: job.errors,
    message: job.message,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/status") {
    try {
      const [timePayload, symbols] = await Promise.all([bybitGet("/v5/market/time"), loadUniverse()]);
      sendJson(response, 200, {
        connected: true,
        endpoint: API_BASE,
        readOnly: true,
        configuredSymbols: symbols.length,
        serverTime: timePayload?.time,
      });
    } catch (error) {
      sendJson(response, 503, { connected: false, endpoint: API_BASE, message: cleanError(error) });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/symbols") {
    try {
      const symbols = await loadUniverse();
      const counts = Object.entries(symbols.reduce((acc, symbol) => {
        acc[symbol.category] = (acc[symbol.category] || 0) + 1;
        return acc;
      }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
      sendJson(response, 200, { symbols, categories: counts, count: symbols.length });
    } catch (error) {
      sendJson(response, 500, { message: cleanError(error) });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/scan") {
    try {
      const body = await readJson(request);
      const job = {
        id: randomUUID(), status: "queued", total: 0, scanned: 0, failed: 0,
        current: "", results: [], errors: [], message: "", startedAt: null,
        updatedAt: new Date().toISOString(), finishedAt: null,
      };
      jobs.set(job.id, job);
      runScan(job, Array.isArray(body.categories) ? body.categories : []).catch((error) => {
        job.status = "failed";
        job.message = cleanError(error);
      });
      while (jobs.size > 8) jobs.delete(jobs.keys().next().value);
      sendJson(response, 202, publicJob(job));
    } catch (error) {
      sendJson(response, 400, { message: cleanError(error) });
    }
    return;
  }
  const jobMatch = url.pathname.match(/^\/api\/scan\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(response, 404, { message: "Scan job not found" });
    return sendJson(response, 200, publicJob(job));
  }
  sendJson(response, 404, { message: "API route not found" });
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(PUBLIC_ROOT, requested));
  if (!filePath.startsWith(PUBLIC_ROOT)) return sendJson(response, 403, { message: "Forbidden" });
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(response, 404, { message: "Not found" });
    throw error;
  }
}

export function createScannerServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
      else await serveStatic(response, url.pathname);
    } catch (error) {
      sendJson(response, 500, { message: cleanError(error) });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createScannerServer().listen(PORT, HOST, () => {
    console.log(`Bybit EMA Touch Scanner: http://${HOST}:${PORT}`);
    console.log(`Public market data: ${API_BASE}`);
    console.log(`Trading pairs: ${SYMBOLS_FILE}`);
  });
}
