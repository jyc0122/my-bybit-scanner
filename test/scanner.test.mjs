import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeSymbol,
  analyzeWeakeningCandidate,
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

const timeframeSteps = {
  "4H": 14_400_000,
  "1D": 86_400_000,
};

function dualLrcBars(count, stepMs, dailySide) {
  const direction = dailySide === "long" ? 1 : -1;
  const bars = trendBars(count, direction, stepMs);
  const triggerCloses = dailySide === "long"
    ? [1057, 1056, 1055, 1054, 1053, 1052]
    : [943, 944, 945, 946, 947, 948];
  triggerCloses.forEach((close, offset) => {
    const index = count - triggerCloses.length + offset;
    bars[index] = {
      ...bars[index],
      o: close - direction * 0.1,
      h: close + 0.2,
      l: close - 0.2,
      c: close,
    };
  });
  const reachIndex = count - 3;
  if (dailySide === "short") bars[reachIndex].h = bars[reachIndex].c + 10;
  else bars[reachIndex].l = bars[reachIndex].c - 10;
  return bars;
}

function weakeningDualLrcBars(count, stepMs, dailySide) {
  const direction = dailySide === "long" ? 1 : -1;
  const bars = trendBars(count, direction, stepMs);
  const closes = dailySide === "long"
    ? [1060, 1058, 1056, 1054, 1052, 1050, 1056]
    : [940, 942, 944, 946, 948, 950, 944];
  closes.forEach((close, offset) => {
    const index = count - closes.length + offset;
    bars[index] = { ...bars[index], o: close, h: close + 0.2, l: close - 0.2, c: close };
  });
  const reachIndex = count - 3;
  if (dailySide === "short") bars[reachIndex].h = bars[reachIndex].c + 10;
  else bars[reachIndex].l = bars[reachIndex].c - 10;
  return bars;
}

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
  const bars = normalizeKlines(payload, "D", now);
  assert.deepEqual(bars.map((bar) => bar.ts), [day, 2 * day]);
});

test("drops the current unfinished Binance candle using its close time", () => {
  const day = 86_400_000;
  const now = 3 * day + day / 2;
  const payload = [
    [3 * day, "3", "4", "2", "3.5", "1", 4 * day - 1, "3.5", 1, "0", "0", "0"],
    [day, "1", "2", "0", "1.5", "1", 2 * day - 1, "1.5", 1, "0", "0", "0"],
    [2 * day, "2", "3", "1", "2.5", "1", 3 * day - 1, "2.5", 1, "0", "0", "0"],
  ];
  const bars = normalizeBinanceKlines(payload, "1d", now);
  assert.deepEqual(bars.map((bar) => bar.ts), [day, 2 * day]);
  assert.deepEqual(bars.map((bar) => bar.turnover), [1.5, 2.5]);
});

test("keeps only confirmed OKX candles and sorts oldest first", () => {
  const day = 86_400_000;
  const payload = { code: "0", data: [
    [String(3 * day), "3", "4", "2", "3.5", "1", "1", "3.5", "0"],
    [String(2 * day), "2", "3", "1", "2.5", "1", "1", "2.5", "1"],
    [String(day), "1", "2", "0", "1.5", "1", "1", "1.5", "1"],
  ] };
  const bars = normalizeOkxKlines(payload);
  assert.deepEqual(bars.map((bar) => bar.ts), [day, 2 * day]);
  assert.deepEqual(bars.map((bar) => bar.turnover), [1.5, 2.5]);
});

test("maps configured aliases to OKX USDT perpetual instrument ids", () => {
  assert.equal(okxInstrumentIdForSymbol("BTCUSDT"), "BTC-USDT-SWAP");
  assert.equal(okxInstrumentIdForSymbol("1000PEPEUSDT"), "PEPE-USDT-SWAP");
  assert.equal(okxInstrumentIdForSymbol("SHIB1000USDT"), "SHIB-USDT-SWAP");
  assert.equal(okxInstrumentIdForSymbol("PUMPFUNUSDT"), "PUMP-USDT-SWAP");
  assert.equal(okxInstrumentIdForSymbol("RAYDIUMUSDT"), "RAY-USDT-SWAP");
});

test("daily short qualifies on either 4H or 1D when all setup rules pass", () => {
  for (const timeframe of Object.keys(timeframeSteps)) {
    const dailyBars = timeframe === "1D"
      ? dualLrcBars(60, timeframeSteps["1D"], "short")
      : trendBars(60, -1, timeframeSteps["1D"]);
    const h4Bars = timeframe === "4H"
      ? dualLrcBars(60, timeframeSteps["4H"], "short")
      : trendBars(60, -1, timeframeSteps["4H"]);
    const result = analyzeSymbol(symbol, dailyBars, h4Bars);
    assert.equal(result.side, "short", `${timeframe} alone should qualify`);
    assert.equal(result.signalSide, "long");
    assert.equal(result.selectedTimeframe, timeframe);
    assert.deepEqual(result.qualifyingTimeframes, [timeframe]);
    assert.ok(result.selectedLrc25Angle < -20);
    assert.ok(result.selectedLrc6Angle > 0);
    assert.equal(result.confirmations.find((item) => item.timeframe === timeframe).ema21ReachPassed, true);
  }
});

test("daily long qualifies on 4H when LRC25, LRC6, and EMA21 reach rules pass", () => {
  const result = analyzeSymbol(
    symbol,
    trendBars(60, 1, timeframeSteps["1D"]),
    dualLrcBars(60, timeframeSteps["4H"], "long"),
  );
  assert.equal(result.side, "long");
  assert.equal(result.signalSide, "short");
  assert.equal(result.selectedTimeframe, "4H");
  assert.ok(result.selectedLrc25Angle > 20);
  assert.ok(result.selectedLrc6Angle < 0);
});

test("rejects a setup when the LRC25 absolute angle is 20 degrees or less", () => {
  const shallowLrc25 = dualLrcBars(60, timeframeSteps["4H"], "short");
  shallowLrc25.at(-10).h += 500;
  shallowLrc25.at(-10).l -= 500;
  const result = analyzeSymbol(symbol, trendBars(60, -1, timeframeSteps["1D"]), shallowLrc25);
  const confirmation = result.confirmations.find((item) => item.timeframe === "4H");
  assert.ok(Math.abs(confirmation.lrc25Angle) <= 20);
  assert.equal(confirmation.lrc25MagnitudePassed, false);
  assert.equal(confirmation.ema21ReachPassed, true);
  assert.equal(result.side, "neutral");
});

test("rejects a setup when none of the latest five candles reaches across EMA21", () => {
  const noReach = dualLrcBars(60, timeframeSteps["4H"], "short");
  noReach.slice(-5).forEach((bar) => { bar.h = bar.c + 0.2; bar.l = bar.c - 0.2; });
  const result = analyzeSymbol(symbol, trendBars(60, -1, timeframeSteps["1D"]), noReach);
  const confirmation = result.confirmations.find((item) => item.timeframe === "4H");
  assert.equal(confirmation.lrc25Passed, true);
  assert.equal(confirmation.lrc6Passed, true);
  assert.equal(confirmation.ema21ReachPassed, false);
  assert.equal(result.side, "neutral");
});

test("marks a daily-short setup when positive LRC6 weakens on 4H", () => {
  const result = analyzeSymbol(
    symbol,
    trendBars(60, -1, timeframeSteps["1D"]),
    weakeningDualLrcBars(60, timeframeSteps["4H"], "short"),
  );
  assert.equal(result.side, "short");
  assert.equal(result.selectedTimeframe, "4H");
  assert.ok(result.selectedLrc6Angle > 0);
  assert.ok(result.selectedPreviousLrc6Angle > result.selectedLrc6Angle);
  assert.equal(result.selectedLrc6Weakening, true);
});

test("checks LRC6 weakening for saved 4H and 1D candidates", () => {
  for (const timeframe of Object.keys(timeframeSteps)) {
    const bars = weakeningDualLrcBars(60, timeframeSteps[timeframe], "short");
    const result = analyzeWeakeningCandidate(bars, timeframe, "short");
    assert.equal(result.selectedTimeframe, timeframe);
    assert.equal(result.selectedLrc6Weakening, true);
    assert.ok(result.selectedPreviousLrc6Angle > result.selectedLrc6Angle);
  }
});

test("checks negative LRC6 weakening toward zero for a saved daily-long candidate", () => {
  const bars = weakeningDualLrcBars(60, timeframeSteps["1D"], "long");
  const result = analyzeWeakeningCandidate(bars, "1D", "long");
  assert.equal(result.selectedLrc6Weakening, true);
  assert.ok(result.selectedLrc6Angle < 0);
  assert.ok(result.selectedPreviousLrc6Angle < 0);
  assert.ok(Math.abs(result.selectedLrc6Angle) < Math.abs(result.selectedPreviousLrc6Angle));
});

test("shows only 1D when both 4H and 1D qualify", () => {
  const result = analyzeSymbol(
    symbol,
    dualLrcBars(60, timeframeSteps["1D"], "short"),
    dualLrcBars(60, timeframeSteps["4H"], "short"),
  );
  assert.deepEqual(result.matchedTimeframes, ["4H", "1D"]);
  assert.equal(result.selectedTimeframe, "1D");
  assert.deepEqual(result.qualifyingTimeframes, ["1D"]);
});

test("rejects daily short when LRC25 is negative but LRC6 is not positive", () => {
  const result = analyzeSymbol(
    symbol,
    trendBars(60, -1, timeframeSteps["1D"]),
    trendBars(60, -1, timeframeSteps["4H"]),
  );
  assert.equal(result.confirmations[0].lrc25Passed, true);
  assert.equal(result.confirmations[0].lrc6Passed, false);
  assert.equal(result.side, "neutral");
});

test("rejects daily short when LRC6 is positive but LRC25 is not negative", () => {
  const result = analyzeSymbol(
    symbol,
    trendBars(60, -1, timeframeSteps["1D"]),
    trendBars(60, 1, timeframeSteps["4H"]),
  );
  assert.equal(result.confirmations[0].lrc25Passed, false);
  assert.equal(result.confirmations[0].lrc6Passed, true);
  assert.equal(result.side, "neutral");
});

test("daily EMA21 direction no longer rejects candles that touch EMA21", () => {
  const dailyBars = trendBars(60, -1, timeframeSteps["1D"]);
  dailyBars.at(-1).h += 100;
  const result = analyzeSymbol(symbol, dailyBars, dualLrcBars(60, timeframeSteps["4H"], "short"));
  assert.equal(result.dailySide, "short");
  assert.equal(result.side, "short");
});
