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

function dailySignalBars(side) {
  const direction = side === "long" ? 1 : -1;
  const bars = trendBars(40, direction);
  bars.forEach((bar, index) => {
    const close = index < 38
      ? 100 + (index % 2 === 0 ? -10 : 10)
      : 100 + direction * (index - 36);
    bars[index] = { ...bar, o: close, h: close + 0.2, l: close - 0.2, c: close };
  });
  return bars;
}

const intradaySteps = {
  "15m": 900_000,
  "1H": 3_600_000,
  "4H": 14_400_000,
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

function intradayBars(signals = {}) {
  return Object.entries(intradaySteps).map(([timeframe, stepMs]) => {
    const signal = signals[timeframe] || "long";
    if (signal === "shortSetup") return dualLrcBars(60, stepMs, "short");
    if (signal === "longSetup") return dualLrcBars(60, stepMs, "long");
    if (signal === "shortWeakening") return weakeningDualLrcBars(60, stepMs, "short");
    if (signal === "longWeakening") return weakeningDualLrcBars(60, stepMs, "long");
    return trendBars(60, signal === "short" ? -1 : 1, stepMs);
  });
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

test("daily short qualifies when LRC25 is below -20, LRC6 is positive, and a recent high exceeds EMA21", () => {
  for (const timeframe of Object.keys(intradaySteps)) {
    const signals = { "15m": "short", "1H": "short", "4H": "short", [timeframe]: "shortSetup" };
    const result = analyzeSymbol(symbol, dailySignalBars("short"), ...intradayBars(signals));
    assert.equal(result.side, "short", `${timeframe} alone should qualify`);
    assert.equal(result.signalSide, "long");
    assert.equal(result.selectedTimeframe, timeframe);
    assert.deepEqual(result.qualifyingTimeframes, [timeframe]);
    assert.ok(result.selectedLrc25Angle < 0);
    assert.ok(Math.abs(result.selectedLrc25Angle) > 20);
    assert.ok(result.selectedLrc6Angle > 0);
    assert.equal(result.confirmations.find((item) => item.timeframe === timeframe).ema21ReachPassed, true);
    assert.equal(result.dailyEma21DistancePct, Math.abs(result.emaDistancePct));
    assert.equal(result.dailyBollPassed, true);
  }
});

test("daily long qualifies when LRC25 is above 20, LRC6 is negative, and a recent low falls below EMA21", () => {
  const result = analyzeSymbol(symbol, dailySignalBars("long"), ...intradayBars({ "1H": "longSetup" }));
  assert.equal(result.side, "long");
  assert.equal(result.signalSide, "short");
  assert.equal(result.selectedTimeframe, "1H");
  assert.ok(result.selectedLrc25Angle > 0);
  assert.ok(Math.abs(result.selectedLrc25Angle) > 20);
  assert.ok(result.selectedLrc6Angle < 0);
  assert.equal(result.confirmations.find((item) => item.timeframe === "1H").ema21ReachPassed, true);
});

test("rejects a setup when the LRC25 absolute angle is 20 degrees or less", () => {
  const shallowLrc25 = dualLrcBars(60, intradaySteps["1H"], "short");
  shallowLrc25.at(-10).h += 500;
  shallowLrc25.at(-10).l -= 500;
  const [m15, , h4] = intradayBars({ "15m": "short", "4H": "short" });
  const result = analyzeSymbol(symbol, dailySignalBars("short"), m15, shallowLrc25, h4);
  const confirmation = result.confirmations.find((item) => item.timeframe === "1H");
  assert.ok(Math.abs(confirmation.lrc25Angle) <= 20);
  assert.equal(confirmation.lrc25MagnitudePassed, false);
  assert.equal(confirmation.ema21ReachPassed, true);
  assert.equal(result.side, "neutral");
});

test("rejects a setup when none of the latest five candles reaches across EMA21", () => {
  const noReach = dualLrcBars(60, intradaySteps["1H"], "short");
  noReach.slice(-5).forEach((bar) => { bar.h = bar.c + 0.2; bar.l = bar.c - 0.2; });
  const [m15, , h4] = intradayBars({ "15m": "short", "4H": "short" });
  const result = analyzeSymbol(symbol, dailySignalBars("short"), m15, noReach, h4);
  const confirmation = result.confirmations.find((item) => item.timeframe === "1H");
  assert.equal(confirmation.lrc25Passed, true);
  assert.equal(confirmation.lrc6Passed, true);
  assert.equal(confirmation.ema21ReachPassed, false);
  assert.equal(result.side, "neutral");
});

test("marks a daily-short setup when positive LRC6 weakens on its qualifying timeframe", () => {
  const result = analyzeSymbol(symbol, dailySignalBars("short"), ...intradayBars({
    "15m": "short",
    "1H": "shortWeakening",
    "4H": "short",
  }));
  assert.equal(result.side, "short");
  assert.equal(result.selectedTimeframe, "1H");
  assert.ok(result.selectedLrc6Angle > 0);
  assert.ok(result.selectedPreviousLrc6Angle > 0);
  assert.ok(Math.abs(result.selectedLrc6Angle) < Math.abs(result.selectedPreviousLrc6Angle));
  assert.equal(result.selectedLrc6Weakening, true);
});

test("marks a daily-long setup when negative LRC6 weakens toward zero", () => {
  const result = analyzeSymbol(symbol, dailySignalBars("long"), ...intradayBars({
    "15m": "long",
    "1H": "longWeakening",
    "4H": "long",
  }));
  assert.equal(result.side, "long");
  assert.equal(result.selectedTimeframe, "1H");
  assert.ok(result.selectedLrc6Angle < 0);
  assert.ok(result.selectedPreviousLrc6Angle < 0);
  assert.ok(Math.abs(result.selectedLrc6Angle) < Math.abs(result.selectedPreviousLrc6Angle));
  assert.equal(result.selectedLrc6Weakening, true);
});

test("checks LRC6 weakening for a saved candidate without repeating the daily scan", () => {
  const bars = weakeningDualLrcBars(60, intradaySteps["1H"], "short");
  const result = analyzeWeakeningCandidate(bars, "1H", "short");
  assert.equal(result.side, "short");
  assert.equal(result.selectedTimeframe, "1H");
  assert.equal(result.selectedLrc6Weakening, true);
  assert.ok(result.selectedLrc6Angle > 0);
  assert.ok(result.selectedPreviousLrc6Angle > result.selectedLrc6Angle);
});

test("shows only the largest qualifying timeframe when several dual-LRC setups match", () => {
  const result = analyzeSymbol(symbol, dailySignalBars("short"), ...intradayBars({ "15m": "shortSetup", "1H": "shortSetup", "4H": "shortSetup" }));
  assert.deepEqual(result.matchedTimeframes, ["15m", "1H", "4H"]);
  assert.equal(result.selectedTimeframe, "4H");
  assert.deepEqual(result.qualifyingTimeframes, ["4H"]);
});

test("rejects daily short when LRC25 is negative but LRC6 is not positive", () => {
  const result = analyzeSymbol(symbol, dailySignalBars("short"), ...intradayBars());
  const shortBars = trendBars(60, -1, intradaySteps["15m"]);
  const [, h1, h4] = intradayBars({ "1H": "short", "4H": "short" });
  const rejected = analyzeSymbol(symbol, dailySignalBars("short"), shortBars, h1, h4);
  assert.equal(rejected.confirmations[0].lrc25Passed, true);
  assert.equal(rejected.confirmations[0].lrc6Passed, false);
  assert.equal(rejected.side, "neutral");
  assert.equal(result.side, "neutral");
});

test("rejects daily short when LRC6 is positive but LRC25 is not negative", () => {
  const result = analyzeSymbol(symbol, dailySignalBars("short"), ...intradayBars());
  assert.equal(result.confirmations[0].lrc25Passed, false);
  assert.equal(result.confirmations[0].lrc6Passed, true);
  assert.equal(result.side, "neutral");
});

test("rejects lower-timeframe LRC25 pointing in the same direction as the daily trend", () => {
  const result = analyzeSymbol(symbol, dailySignalBars("long"), ...intradayBars());
  assert.equal(result.dailySide, "long");
  assert.equal(result.confirmationPassed, false);
  assert.equal(result.side, "neutral");
});

test("rejects when either of the latest two daily candles touches daily EMA21", () => {
  const result = analyzeSymbol(symbol, touchBars(40, 86_400_000), ...intradayBars());
  assert.equal(result.dailyNoTouch, false);
  assert.equal(result.side, "neutral");
});

test("rejects a setup when the latest daily close is outside Bollinger 21 with one standard deviation", () => {
  const result = analyzeSymbol(symbol, trendBars(40, -1), ...intradayBars({ "1H": "shortSetup" }));
  assert.ok(result.close < result.dailyBoll21Lower);
  assert.equal(result.dailyBollPassed, false);
  assert.equal(result.dailySide, "neutral");
  assert.equal(result.side, "neutral");
});
