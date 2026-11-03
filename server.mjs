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
const BYBIT_API_BASE = String(process.env.BYBIT_API_BASE || "https://api.bybit.com").replace(/\/$/, "");
const BINANCE_API_BASE = String(process.env.BINANCE_API_BASE || "https://fapi.binance.com").replace(/\/$/, "");
const OKX_API_BASE = String(process.env.OKX_API_BASE || "https://openapi.okx.com").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.BYBIT_REQUEST_TIMEOUT_MS || 20_000);
const SCAN_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BYBIT_SCAN_CONCURRENCY || 4)));
const REQUEST_GAP_MS = Math.max(50, Number(process.env.BYBIT_REQUEST_GAP_MS || 125));
const RATE_LIMIT_RETRIES = Math.max(0, Math.min(8, Number(process.env.BYBIT_RATE_LIMIT_RETRIES || 6)));
const jobs = new Map();
let nextRequestAt = 0;
let requestGate = Promise.resolve();
let binanceExchangeCache = { expiresAt: 0, symbols: new Set() };
let okxInstrumentCache = { expiresAt: 0, symbols: new Set() };

const OKX_BASE_ALIASES = new Map([
  ["1000PEPE", "PEPE"],
  ["1000BONK", "BONK"],
  ["SHIB1000", "SHIB"],
  ["PUMPFUN", "PUMP"],
  ["RAYDIUM", "RAY"],
]);

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
  const url = new URL(pathname, `${BYBIT_API_BASE}/`);
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

async function binanceGet(pathname, params = {}) {
  const url = new URL(pathname, `${BINANCE_API_BASE}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    await waitForRequestSlot();
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "multi-source-lrc-scanner/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch {
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}: ${text.slice(0, 240) || response.statusText}`);
      throw new Error("Binance returned invalid JSON");
    }
    const rateLimited = response.status === 418 || response.status === 429 || Number(payload?.code) === -1003;
    if (rateLimited && attempt < RATE_LIMIT_RETRIES) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const retryAfter = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0;
      const delay = Math.max(retryAfter, Math.min(10_000, 500 * (2 ** attempt)));
      nextRequestAt = Math.max(nextRequestAt, Date.now() + delay);
      await sleep(delay);
      continue;
    }
    if (!response.ok) throw new Error(`Binance HTTP ${response.status}: ${payload?.msg || text.slice(0, 240) || response.statusText}`);
    if (payload && !Array.isArray(payload) && Number(payload.code) < 0) {
      throw new Error(`Binance ${payload.code}: ${payload.msg || "request failed"}`);
    }
    return payload;
  }
  throw new Error("Binance rate limit retry budget exhausted");
}

async function okxGet(pathname, params = {}) {
  const url = new URL(pathname, `${OKX_API_BASE}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    await waitForRequestSlot();
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "multi-source-lrc-scanner/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch {
      if (!response.ok) throw new Error(`OKX HTTP ${response.status}: ${text.slice(0, 240) || response.statusText}`);
      throw new Error("OKX returned invalid JSON");
    }
    const rateLimited = response.status === 429 || ["50011", "50040"].includes(String(payload?.code));
    if (rateLimited && attempt < RATE_LIMIT_RETRIES) {
      const delay = Math.min(10_000, 500 * (2 ** attempt));
      nextRequestAt = Math.max(nextRequestAt, Date.now() + delay);
      await sleep(delay);
      continue;
    }
    if (!response.ok) throw new Error(`OKX HTTP ${response.status}: ${payload?.msg || text.slice(0, 240) || response.statusText}`);
    if (String(payload?.code) !== "0") throw new Error(`OKX ${payload?.code ?? "error"}: ${payload?.msg || "request failed"}`);
    return payload;
  }
  throw new Error("OKX rate limit retry budget exhausted");
}

function normalizeSource(value) {
  const source = String(value || "bybit").trim().toLowerCase();
  if (!["bybit", "binance", "okx"].includes(source)) throw new Error(`Unsupported data source: ${source}`);
  return source;
}

function sourceMetadata(source) {
  if (source === "binance") return { source, name: "Binance USDⓈ-M Futures", endpoint: BINANCE_API_BASE };
  if (source === "okx") return { source, name: "OKX USDT Perpetual", endpoint: OKX_API_BASE };
  return { source, name: "Bybit Public V5", endpoint: BYBIT_API_BASE };
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

async function getBinanceTradingSymbols() {
  if (binanceExchangeCache.expiresAt > Date.now()) return binanceExchangeCache.symbols;
  const payload = await binanceGet("/fapi/v1/exchangeInfo");
  const symbols = new Set((payload?.symbols || [])
    .filter((item) => item?.status === "TRADING" && item?.contractType === "PERPETUAL" && item?.quoteAsset === "USDT")
    .map((item) => String(item.symbol || "").toUpperCase())
    .filter(Boolean));
  binanceExchangeCache = { expiresAt: Date.now() + 5 * 60_000, symbols };
  return symbols;
}

export function okxInstrumentIdForSymbol(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  const base = normalized.endsWith("USDT") ? normalized.slice(0, -4) : normalized;
  return `${OKX_BASE_ALIASES.get(base) || base}-USDT-SWAP`;
}

async function getOkxTradingSymbols() {
  if (okxInstrumentCache.expiresAt > Date.now()) return okxInstrumentCache.symbols;
  const payload = await okxGet("/api/v5/public/instruments", { instType: "SWAP" });
  const symbols = new Set((payload?.data || [])
    .filter((item) => item?.state === "live" && item?.settleCcy === "USDT" && String(item?.instId || "").endsWith("-USDT-SWAP"))
    .map((item) => String(item.instId).toUpperCase()));
  okxInstrumentCache = { expiresAt: Date.now() + 5 * 60_000, symbols };
  return symbols;
}

async function filterUniverseForSource(universe, source) {
  if (source === "bybit") return universe;
  if (source === "binance") {
    const tradingSymbols = await getBinanceTradingSymbols();
    return universe.filter((item) => tradingSymbols.has(item.symbol));
  }
  const tradingSymbols = await getOkxTradingSymbols();
  return universe
    .map((item) => ({ ...item, sourceSymbol: okxInstrumentIdForSymbol(item.symbol) }))
    .filter((item) => tradingSymbols.has(item.sourceSymbol));
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

export function normalizeBinanceKlines(payload, interval, now = Date.now()) {
  if (!Array.isArray(payload)) throw new Error("Binance kline response is not an array");
  return payload
    .filter((row) => Array.isArray(row) && row.length >= 8)
    .map((row) => ({
      t: new Date(Number(row[0])).toISOString().slice(0, 10),
      ts: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
      closeTs: Number(row[6]),
      turnover: Number(row[7]),
    }))
    .filter((bar) => [bar.ts, bar.o, bar.h, bar.l, bar.c, bar.closeTs].every(Number.isFinite) && bar.closeTs < now)
    .sort((a, b) => a.ts - b.ts)
    .filter((bar, index, bars) => index === bars.length - 1 || bar.ts !== bars[index + 1].ts)
    .map(({ closeTs, ...bar }) => bar);
}

export function normalizeOkxKlines(payload) {
  const rows = payload?.data;
  if (!Array.isArray(rows)) throw new Error("OKX candle response does not contain data");
  return rows
    .filter((row) => Array.isArray(row) && row.length >= 9 && String(row[8]) === "1")
    .map((row) => ({
      t: new Date(Number(row[0])).toISOString().slice(0, 10),
      ts: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
      turnover: Number(row[7]),
    }))
    .filter((bar) => [bar.ts, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite))
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

function enrichEma21Bars(bars) {
  const ema21 = ema(bars.map((bar) => bar.c), 21);
  return bars.map((bar, index) => ({
    ...bar,
    e21: ema21[index],
  }));
}

function bollinger(values, period = 21, multiplier = 1) {
  const output = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const basis = window.reduce((sum, value) => sum + value, 0) / period;
    const variance = window.reduce((sum, value) => sum + (value - basis) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * multiplier;
    output[index] = {
      basis,
      upper: basis + deviation,
      lower: basis - deviation,
    };
  }
  return output;
}

function candleTouches(bar, value) {
  return Number.isFinite(value) && bar.l <= value && bar.h >= value;
}

function lrcAngle(bars, length = 25) {
  if (bars.length < length) return null;
  const window = bars.slice(-length);
  const meanX = (length - 1) * 0.5;
  const meanY = window.reduce((sum, bar) => sum + bar.c, 0) / length;
  let sumXX = 0;
  let sumXY = 0;
  for (let index = 0; index < length; index += 1) {
    const xDeviation = index - meanX;
    sumXX += xDeviation * xDeviation;
    sumXY += xDeviation * (window[index].c - meanY);
  }
  const slope = sumXX !== 0 ? sumXY / sumXX : 0;
  const priceRange = Math.max(
    Math.max(...window.map((bar) => bar.h)) - Math.min(...window.map((bar) => bar.l)),
    Number.EPSILON,
  );
  const normalizedRise = slope * (length - 1) / priceRange;
  return Math.atan(normalizedRise) * 180 / Math.PI;
}

function evaluateLrcSetup(bars, timeframe, dailySide) {
  if (bars.length < 25) {
    throw new Error(`Only ${bars.length} closed ${timeframe} bars returned; 25 are required`);
  }
  const lrc25Angle = lrcAngle(bars, 25);
  const lrc6Angle = lrcAngle(bars, 6);
  const previousLrc6Angle = lrcAngle(bars.slice(0, -1), 6);
  const lrc25Side = lrc25Angle > 0 ? "long" : lrc25Angle < 0 ? "short" : "neutral";
  const lrc6Side = lrc6Angle > 0 ? "long" : lrc6Angle < 0 ? "short" : "neutral";
  const previousLrc6Side = previousLrc6Angle > 0 ? "long" : previousLrc6Angle < 0 ? "short" : "neutral";
  const requiredLrc25Side = dailySide;
  const requiredLrc6Side = dailySide === "short" ? "long" : dailySide === "long" ? "short" : "neutral";
  const lrc25MagnitudePassed = Number.isFinite(lrc25Angle) && Math.abs(lrc25Angle) > 20;
  const recentEma21Bars = enrichEma21Bars(bars).slice(-5);
  const ema21ReachPassed = dailySide === "short"
    ? recentEma21Bars.some((bar) => Number.isFinite(bar.e21) && bar.h > bar.e21)
    : dailySide === "long"
      ? recentEma21Bars.some((bar) => Number.isFinite(bar.e21) && bar.l < bar.e21)
      : false;
  const lrc25Passed = requiredLrc25Side !== "neutral"
    && lrc25Side === requiredLrc25Side
    && lrc25MagnitudePassed;
  const lrc6Passed = requiredLrc6Side !== "neutral" && lrc6Side === requiredLrc6Side;
  const lrc6Weakening = lrc6Passed
    && previousLrc6Side === requiredLrc6Side
    && Math.abs(lrc6Angle) < Math.abs(previousLrc6Angle);
  return {
    timeframe,
    passed: lrc25Passed && lrc6Passed && ema21ReachPassed,
    lrc25Passed,
    lrc25MagnitudePassed,
    lrc6Passed,
    ema21ReachPassed,
    lrc25Side,
    lrc6Side,
    previousLrc6Side,
    requiredLrc25Side,
    requiredLrc6Side,
    lrc25Angle,
    lrc6Angle,
    previousLrc6Angle,
    lrc6Weakening,
    asOf: new Date(bars.at(-1).ts).toISOString().replace("T", " ").slice(0, 16) + " UTC",
  };
}

export function analyzeWeakeningCandidate(bars, timeframe, side) {
  if (!["15m", "1H", "4H"].includes(timeframe)) throw new Error(`Unsupported candidate timeframe: ${timeframe}`);
  if (!["long", "short"].includes(side)) throw new Error(`Unsupported candidate side: ${side}`);
  const confirmation = evaluateLrcSetup(bars, timeframe, side);
  return {
    side,
    selectedTimeframe: timeframe,
    selectedLrc6Angle: confirmation.lrc6Angle,
    selectedPreviousLrc6Angle: confirmation.previousLrc6Angle,
    selectedLrc6Weakening: confirmation.lrc6Weakening,
    asOf: confirmation.asOf,
  };
}

export function analyzeSymbol(symbol, dailyBars, m15Bars, h1Bars, h4Bars) {
  if (dailyBars.length < 22) throw new Error(`Only ${dailyBars.length} closed daily bars returned; 22 are required`);
  const enriched = enrichEma21Bars(dailyBars);
  const last = enriched.at(-1);
  const previous = enriched.at(-2);
  const recentDaily = enriched.slice(-2);
  const dailyNoTouch = recentDaily.every((bar) => !candleTouches(bar, bar.e21));
  const dailyBoll21 = bollinger(dailyBars.map((bar) => bar.c), 21, 1).at(-1);
  const dailyBollPassed = Number.isFinite(dailyBoll21?.upper)
    && Number.isFinite(dailyBoll21?.lower)
    && last.c >= dailyBoll21.lower
    && last.c <= dailyBoll21.upper;
  const dailySide = dailyNoTouch && dailyBollPassed && last.c > last.e21
    ? "long"
    : dailyNoTouch && dailyBollPassed && last.c < last.e21
      ? "short"
      : "neutral";
  const confirmations = [
    evaluateLrcSetup(m15Bars, "15m", dailySide),
    evaluateLrcSetup(h1Bars, "1H", dailySide),
    evaluateLrcSetup(h4Bars, "4H", dailySide),
  ];
  const matchedTimeframes = confirmations.filter((confirmation) => confirmation.passed);
  const selectedConfirmation = matchedTimeframes.at(-1) || null;
  const confirmationPassed = selectedConfirmation !== null;
  const side = dailySide !== "neutral" && confirmationPassed ? dailySide : "neutral";
  const emaDistancePct = (last.c / last.e21 - 1) * 100;
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
    emaDistancePct,
    dailyEma21DistancePct: Math.abs(emaDistancePct),
    dailyNoTouch,
    dailyBollPassed,
    dailyBoll21Basis: dailyBoll21?.basis ?? null,
    dailyBoll21Upper: dailyBoll21?.upper ?? null,
    dailyBoll21Lower: dailyBoll21?.lower ?? null,
    dailyBarsChecked: recentDaily.map((bar) => ({
      at: bar.t,
      touched: candleTouches(bar, bar.e21),
      ema21: bar.e21,
    })),
    confirmationPassed,
    confirmations,
    signalSide: selectedConfirmation?.lrc6Side || "neutral",
    selectedTimeframe: selectedConfirmation?.timeframe || null,
    selectedLrc25Side: selectedConfirmation?.lrc25Side || "neutral",
    selectedLrc6Side: selectedConfirmation?.lrc6Side || "neutral",
    selectedLrc25Angle: selectedConfirmation?.lrc25Angle ?? null,
    selectedLrc6Angle: selectedConfirmation?.lrc6Angle ?? null,
    selectedPreviousLrc6Angle: selectedConfirmation?.previousLrc6Angle ?? null,
    selectedLrc6Weakening: selectedConfirmation?.lrc6Weakening || false,
    matchedTimeframes: matchedTimeframes.map((item) => item.timeframe),
    qualifyingTimeframes: selectedConfirmation ? [selectedConfirmation.timeframe] : [],
    asOf: last.t,
  };
}

async function fetchKlines(source, symbol, interval, limit) {
  if (source === "binance") {
    const binanceInterval = { D: "1d", 15: "15m", 60: "1h", 240: "4h" }[interval];
    if (!binanceInterval) throw new Error(`Unsupported Binance interval: ${interval}`);
    const payload = await binanceGet("/fapi/v1/klines", {
      symbol: symbol.symbol,
      interval: binanceInterval,
      limit,
    });
    return normalizeBinanceKlines(payload, binanceInterval);
  }
  if (source === "okx") {
    const okxBar = { D: "1Dutc", 15: "15m", 60: "1H", 240: "4H" }[interval];
    if (!okxBar) throw new Error(`Unsupported OKX interval: ${interval}`);
    const payload = await okxGet("/api/v5/market/candles", {
      instId: symbol.sourceSymbol || okxInstrumentIdForSymbol(symbol.symbol),
      bar: okxBar,
      limit: Math.min(300, limit),
    });
    return normalizeOkxKlines(payload);
  }
  const payload = await bybitGet("/v5/market/kline", {
    category: symbol.market,
    symbol: symbol.symbol,
    interval,
    limit,
  });
  return normalizeKlines(payload, interval);
}

async function getTickerMap(source, symbols) {
  if (source === "binance" || source === "okx") return new Map();
  const markets = [...new Set(symbols.map((item) => item.market))];
  const map = new Map();
  await Promise.all(markets.map(async (market) => {
    const payload = await bybitGet("/v5/market/tickers", { category: market });
    for (const ticker of payload?.result?.list || []) map.set(`${market}:${ticker.symbol}`, ticker);
  }));
  return map;
}

async function runScan(job, categories, requestedSource) {
  try {
    const source = normalizeSource(requestedSource);
    const universe = await loadUniverse();
    const configuredSelection = categories?.length ? universe.filter((symbol) => categories.includes(symbol.category)) : universe;
    const available = await filterUniverseForSource(configuredSelection, source);
    const selected = available;
    if (!selected.length) throw new Error("No configured symbols match the selected groups");
    job.source = source;
    job.sourceName = sourceMetadata(source).name;
    job.skippedUnavailable = configuredSelection.length - selected.length;
    job.status = "running";
    job.total = selected.length;
    job.startedAt = new Date().toISOString();
    const tickers = await getTickerMap(source, selected);
    let cursor = 0;
    const worker = async () => {
      while (cursor < selected.length) {
        const symbol = selected[cursor++];
        job.current = symbol.symbol;
        try {
          const [dailyBars, m15Bars, h1Bars, h4Bars] = await Promise.all([
            fetchKlines(source, symbol, "D", 260),
            fetchKlines(source, symbol, "15", 60),
            fetchKlines(source, symbol, "60", 60),
            fetchKlines(source, symbol, "240", 60),
          ]);
          const analysis = analyzeSymbol(symbol, dailyBars, m15Bars, h1Bars, h4Bars);
          analysis.dataSource = source;
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
        job.results.sort((a, b) => (
          a.dailyEma21DistancePct - b.dailyEma21DistancePct
          || a.symbol.localeCompare(b.symbol)
        ));
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

function normalizeWeakeningCandidates(rawCandidates, universe) {
  if (!Array.isArray(rawCandidates) || !rawCandidates.length) throw new Error("candidates must contain at least one baseline result");
  if (rawCandidates.length > 500) throw new Error("candidates cannot contain more than 500 items");
  const universeBySymbol = new Map(universe.map((item) => [item.symbol, item]));
  const seen = new Set();
  return rawCandidates.map((candidate, index) => {
    const symbol = String(candidate?.symbol || "").trim().toUpperCase();
    const side = String(candidate?.side || "").trim().toLowerCase();
    const selectedTimeframe = String(candidate?.selectedTimeframe || "").trim();
    if (seen.has(symbol)) return null;
    seen.add(symbol);
    const configured = universeBySymbol.get(symbol);
    if (!configured) throw new Error(`candidates[${index}] is not in the configured universe: ${symbol || "(empty)"}`);
    if (!["long", "short"].includes(side)) throw new Error(`candidates[${index}] has invalid side: ${side || "(empty)"}`);
    if (!["15m", "1H", "4H"].includes(selectedTimeframe)) {
      throw new Error(`candidates[${index}] has invalid selectedTimeframe: ${selectedTimeframe || "(empty)"}`);
    }
    return { ...configured, baselineSide: side, baselineTimeframe: selectedTimeframe };
  }).filter(Boolean);
}

async function runWeakeningCheck(job, rawCandidates, requestedSource) {
  try {
    const source = normalizeSource(requestedSource);
    const universe = await loadUniverse();
    const candidates = normalizeWeakeningCandidates(rawCandidates, universe);
    const available = await filterUniverseForSource(candidates, source);
    job.source = source;
    job.sourceName = sourceMetadata(source).name;
    job.mode = "weakening-check";
    job.skippedUnavailable = candidates.length - available.length;
    job.status = "running";
    job.total = available.length;
    job.startedAt = new Date().toISOString();
    let cursor = 0;
    const worker = async () => {
      while (cursor < available.length) {
        const candidate = available[cursor++];
        job.current = candidate.symbol;
        try {
          const interval = { "15m": "15", "1H": "60", "4H": "240" }[candidate.baselineTimeframe];
          const bars = await fetchKlines(source, candidate, interval, 60);
          const weakening = analyzeWeakeningCandidate(bars, candidate.baselineTimeframe, candidate.baselineSide);
          job.scanned += 1;
          if (weakening.selectedLrc6Weakening) {
            job.results.push({
              symbol: candidate.symbol,
              name: candidate.name,
              category: candidate.category,
              market: candidate.market,
              dataSource: source,
              ...weakening,
            });
          }
        } catch (error) {
          job.scanned += 1;
          job.failed += 1;
          if (job.errors.length < 200) job.errors.push({ symbol: candidate.symbol, message: cleanError(error) });
        }
        job.results.sort((a, b) => a.symbol.localeCompare(b.symbol));
        job.updatedAt = new Date().toISOString();
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, available.length) }, worker));
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
    source: job.source,
    sourceName: job.sourceName,
    mode: job.mode || "full-scan",
    status: job.status,
    total: job.total,
    scanned: job.scanned,
    failed: job.failed,
    skippedUnavailable: job.skippedUnavailable,
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
      const source = normalizeSource(url.searchParams.get("source"));
      const symbols = await loadUniverse();
      const available = await filterUniverseForSource(symbols, source);
      const timePayload = source === "binance"
        ? await binanceGet("/fapi/v1/time")
        : source === "okx"
          ? await okxGet("/api/v5/public/time")
          : await bybitGet("/v5/market/time");
      const metadata = sourceMetadata(source);
      sendJson(response, 200, {
        connected: true,
        source,
        sourceName: metadata.name,
        endpoint: metadata.endpoint,
        readOnly: true,
        configuredSymbols: available.length,
        configuredTotal: symbols.length,
        unavailableSymbols: symbols.length - available.length,
        serverTime: source === "binance"
          ? timePayload?.serverTime
          : source === "okx"
            ? timePayload?.data?.[0]?.ts
            : timePayload?.time,
      });
    } catch (error) {
      let source = "bybit";
      try { source = normalizeSource(url.searchParams.get("source")); } catch {}
      const metadata = sourceMetadata(source);
      sendJson(response, 503, { connected: false, source, sourceName: metadata.name, endpoint: metadata.endpoint, message: cleanError(error) });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/symbols") {
    try {
      const source = normalizeSource(url.searchParams.get("source"));
      const configured = await loadUniverse();
      const symbols = await filterUniverseForSource(configured, source);
      const counts = Object.entries(symbols.reduce((acc, symbol) => {
        acc[symbol.category] = (acc[symbol.category] || 0) + 1;
        return acc;
      }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
      sendJson(response, 200, {
        source,
        symbols,
        categories: counts,
        count: symbols.length,
        configuredCount: configured.length,
        unavailableCount: configured.length - symbols.length,
      });
    } catch (error) {
      sendJson(response, 500, { message: cleanError(error) });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/scan") {
    try {
      const body = await readJson(request);
      const source = normalizeSource(body.source);
      const metadata = sourceMetadata(source);
      const job = {
        id: randomUUID(), status: "queued", total: 0, scanned: 0, failed: 0,
        source, sourceName: metadata.name, skippedUnavailable: 0,
        current: "", results: [], errors: [], message: "", startedAt: null,
        updatedAt: new Date().toISOString(), finishedAt: null,
      };
      jobs.set(job.id, job);
      runScan(job, Array.isArray(body.categories) ? body.categories : [], source).catch((error) => {
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
  if (request.method === "POST" && url.pathname === "/api/weakening-check") {
    try {
      const body = await readJson(request);
      const source = normalizeSource(body.source);
      const metadata = sourceMetadata(source);
      const job = {
        id: randomUUID(), status: "queued", mode: "weakening-check", total: 0, scanned: 0, failed: 0,
        source, sourceName: metadata.name, skippedUnavailable: 0,
        current: "", results: [], errors: [], message: "", startedAt: null,
        updatedAt: new Date().toISOString(), finishedAt: null,
      };
      jobs.set(job.id, job);
      runWeakeningCheck(job, body.candidates, source).catch((error) => {
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
    console.log(`Multi-source LRC25/LRC6 Scanner: http://${HOST}:${PORT}`);
    console.log(`Bybit market data: ${BYBIT_API_BASE}`);
    console.log(`Binance market data: ${BINANCE_API_BASE}`);
    console.log(`OKX market data: ${OKX_API_BASE}`);
    console.log(`Trading pairs: ${SYMBOLS_FILE}`);
  });
}
