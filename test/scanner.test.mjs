import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeSymbol,
  loadUniverse,
  normalizeBinanceKlines,
  normalizeKlines,
  normalizeOkxKlines,
  okxInstrumentIdForSymbol,
} from "../server.mjs";

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

const steps = {
  "15m": 900_000,
  "1H": 3_600_000,
  "4H": 14_400_000,
  "1D": 86_400_000,
};

const bars = (timeframe, side) => trendBars(60, side === "long" ? 1 : -1, steps[timeframe]);
const symbol = { symbol: "TESTUSDT", name: "Test", category: "Tests", market: "linear" };

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
  const normalized = normalizeKlines(payload, "D", now);
  assert.deepEqual(normalized.map((bar) => bar.ts), [day, 2 * day]);
});

test("drops the current unfinished Binance candle using its close time", () => {
  const day = 86_400_000;
  const now = 3 * day + day / 2;
  const payload = [
    [3 * day, "3", "4", "2", "3.5", "1", 4 * day - 1, "3.5", 1, "0", "0", "0"],
    [day, "1", "2", "0", "1.5", "1", 2 * day - 1, "1.5", 1, "0", "0", "0"],
    [2 * day, "2", "3", "1", "2.5", "1", 3 * day - 1, "2.5", 1, "0", "0", "0"],
  ];
  const normalized = normalizeBinanceKlines(payload, "1d", now);
  assert.deepEqual(normalized.map((bar) => bar.ts), [day, 2 * day]);
  assert.deepEqual(normalized.map((bar) => bar.turnover), [1.5, 2.5]);
});

test("keeps only confirmed OKX candles and sorts oldest first", () => {
  const day = 86_400_000;
  const payload = { code: "0", data: [
    [String(3 * day), "3", "4", "2", "3.5", "1", "1", "3.5", "0"],
    [String(2 * day), "2", "3", "1", "2.5", "1", "1", "2.5", "1"],
    [String(day), "1", "2", "0", "1.5", "1", "1", "1.5", "1"],
  ] };
  const normalized = normalizeOkxKlines(payload);
  assert.deepEqual(normalized.map((bar) => bar.ts), [day, 2 * day]);
  assert.deepEqual(normalized.map((bar) => bar.turnover), [1.5, 2.5]);
});

test("maps configured aliases to OKX USDT perpetual instrument ids", () => {
  assert.equal(okxInstrumentIdForSymbol("BTCUSDT"), "BTC-USDT-SWAP");
  assert.equal(okxInstrumentIdForSymbol("1000PEPEUSDT"), "PEPE-USDT-SWAP");
  assert.equal(okxInstrumentIdForSymbol("SHIB1000USDT"), "SHIB-USDT-SWAP");
  assert.equal(okxInstrumentIdForSymbol("PUMPFUNUSDT"), "PUMP-USDT-SWAP");
  assert.equal(okxInstrumentIdForSymbol("RAYDIUMUSDT"), "RAY-USDT-SWAP");
});

test("daily LRC25 short selects the largest opposite lower timeframe", () => {
  const result = analyzeSymbol(
    symbol,
    bars("1D", "short"),
    bars("15m", "short"),
    bars("1H", "long"),
    bars("4H", "long"),
  );
  assert.equal(result.dailySide, "short");
  assert.ok(result.dailyLrc25Angle < 0);
  assert.equal(result.side, "long");
  assert.deepEqual(result.matchedTimeframes, ["1H", "4H"]);
  assert.equal(result.selectedTimeframe, "4H");
  assert.ok(result.selectedLrc25Angle > 0);
});

test("daily LRC25 long selects 1H when 4H agrees and 1H plus 15m are opposite", () => {
  const result = analyzeSymbol(
    symbol,
    bars("1D", "long"),
    bars("15m", "short"),
    bars("1H", "short"),
    bars("4H", "long"),
  );
  assert.equal(result.dailySide, "long");
  assert.equal(result.side, "short");
  assert.deepEqual(result.matchedTimeframes, ["15m", "1H"]);
  assert.equal(result.selectedTimeframe, "1H");
  assert.deepEqual(result.qualifyingTimeframes, ["1H"]);
});

test("does not select a symbol when every lower timeframe agrees with daily LRC25", () => {
  const result = analyzeSymbol(
    symbol,
    bars("1D", "long"),
    bars("15m", "long"),
    bars("1H", "long"),
    bars("4H", "long"),
  );
  assert.equal(result.confirmationPassed, false);
  assert.equal(result.side, "neutral");
  assert.equal(result.selectedTimeframe, null);
});

test("uses LRC25 direction without the old 20 degree threshold", () => {
  const shallowLong = bars("4H", "long");
  shallowLong.at(-10).h += 500;
  shallowLong.at(-10).l -= 500;
  const result = analyzeSymbol(
    symbol,
    bars("1D", "short"),
    bars("15m", "short"),
    bars("1H", "short"),
    shallowLong,
  );
  assert.ok(result.selectedLrc25Angle > 0 && result.selectedLrc25Angle <= 20);
  assert.equal(result.selectedTimeframe, "4H");
  assert.equal(result.side, "long");
});

test("requires 25 closed bars for every LRC25 timeframe", () => {
  assert.throws(() => analyzeSymbol(
    symbol,
    bars("1D", "short"),
    trendBars(24, 1, steps["15m"]),
    bars("1H", "long"),
    bars("4H", "long"),
  ), /25 are required/);
});
