import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSymbol, loadUniverse, normalizeKlines } from "../server.mjs";

function trendBars(count, direction = 1, stepMs = 86_400_000) {
  return Array.from({ length: count }, (_, index) => {
    const close = 1_000 + direction * index;
    return {
      t: new Date(index * stepMs).toISOString().slice(0, 10),
      ts: index * stepMs,
      o: close - direction * 0.1,
      h: close + 0.2,
      l: close - 0.2,
      c: close,
      v: 1,
      turnover: close,
    };
  });
}

function touchBars(count, stepMs, close = 100) {
  return Array.from({ length: count }, (_, index) => ({
    t: new Date(index * stepMs).toISOString().slice(0, 10),
    ts: index * stepMs,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: 1,
    turnover: close,
  }));
}

const intradaySteps = {
  "15m": 900_000,
  "30m": 1_800_000,
  "1H": 3_600_000,
  "2H": 7_200_000,
  "4H": 14_400_000,
};

function intradayBars(touchTimeframe = null, direction = 1) {
  return Object.entries(intradaySteps).map(([timeframe, stepMs]) => (
    timeframe === touchTimeframe ? touchBars(220, stepMs) : trendBars(220, direction, stepMs)
  ));
}

function fourthBarOnlyTouch(count, stepMs) {
  const bars = touchBars(count, stepMs);
  for (let index = count - 3; index < count; index += 1) {
    bars[index] = { ...bars[index], o: 110, h: 111, l: 109, c: 110 };
  }
  return bars;
}

test("loads, groups, and normalizes the configured symbol universe", async () => {
  const symbols = await loadUniverse();
  assert.equal(symbols.length, 147);
  assert.ok(symbols.some((item) => item.symbol === "SKHYNIXUSDT" && item.category === "TradFi & Commodities"));
  assert.ok(symbols.some((item) => item.symbol === "RAYDIUMUSDT" && item.category === "Crypto"));
  assert.ok(symbols.every((item) => item.market === "linear"));
});

test("drops the current unfinished Bybit candle and sorts oldest first", () => {
  const day = 86_400_000;
  const now = 3 * day + day / 2;
  const payload = { result: { list: [
    [String(3 * day), "3", "4", "2", "3.5", "1", "3.5"],
    [String(day), "1", "2", "0", "1.5", "1", "1.5"],
    [String(2 * day), "2", "3", "1", "2.5", "1", "2.5"],
  ] } };
  const bars = normalizeKlines(payload, "D", now);
  assert.deepEqual(bars.map((bar) => bar.ts), [day, 2 * day]);
});

test("classifies long when any one of all five intraday timeframes touches", () => {
  const symbol = { symbol: "TESTUSDT", name: "Test", category: "Tests", market: "linear" };
  for (const timeframe of Object.keys(intradaySteps)) {
    const result = analyzeSymbol(symbol, trendBars(40, 1), ...intradayBars(timeframe));
    assert.equal(result.side, "long", `${timeframe} alone should qualify`);
    assert.equal(result.dailyNoTouch, true);
    assert.deepEqual(result.qualifyingTimeframes, [timeframe]);
  }
});

test("classifies short when only 2H provides the EMA144/169 touch", () => {
  const symbol = { symbol: "TESTUSDT", name: "Test", category: "Tests", market: "linear" };
  const result = analyzeSymbol(symbol, trendBars(40, -1), ...intradayBars("2H", -1));
  assert.equal(result.side, "short");
  assert.deepEqual(result.qualifyingTimeframes, ["2H"]);
});

test("rejects when recent daily candles touch EMA21", () => {
  const symbol = { symbol: "TESTUSDT", name: "Test", category: "Tests", market: "linear" };
  const result = analyzeSymbol(symbol, touchBars(40, 86_400_000), ...intradayBars("30m"));
  assert.equal(result.dailyNoTouch, false);
  assert.equal(result.side, "neutral");
});

test("rejects when none of the five intraday timeframes touches EMA144/169", () => {
  const symbol = { symbol: "TESTUSDT", name: "Test", category: "Tests", market: "linear" };
  const result = analyzeSymbol(symbol, trendBars(40, 1), ...intradayBars());
  assert.equal(result.dailySide, "long");
  assert.equal(result.confirmationPassed, false);
  assert.equal(result.side, "neutral");
});

test("does not count an EMA touch on the fourth intraday candle", () => {
  const symbol = { symbol: "TESTUSDT", name: "Test", category: "Tests", market: "linear" };
  const stale15m = fourthBarOnlyTouch(220, intradaySteps["15m"]);
  const [, m30, h1, h2, h4] = intradayBars();
  const result = analyzeSymbol(symbol, trendBars(40, 1), stale15m, m30, h1, h2, h4);
  assert.equal(result.confirmationPassed, false);
  assert.equal(result.side, "neutral");
});
