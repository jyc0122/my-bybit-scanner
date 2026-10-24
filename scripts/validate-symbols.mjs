import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const API_BASE = String(process.env.BYBIT_API_BASE || "https://api.bybit.com").replace(/\/$/, "");
const inputArgument = process.argv.slice(2).find((value) => !value.startsWith("--"));
const inputPath = resolve(inputArgument || "config/requested-symbols.txt");

function parseRequested(text) {
  return text
    .split(/[\s,，]+/u)
    .map((value) => value.trim().replace(/\.P$/iu, "").toUpperCase())
    .filter(Boolean);
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

async function fetchLinearInstruments() {
  const instruments = [];
  let cursor = "";
  do {
    const url = new URL("/v5/market/instruments-info", `${API_BASE}/`);
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "bybit-lrc-scanner/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json();
    if (!response.ok || Number(payload?.retCode) !== 0) {
      throw new Error(`Bybit instrument query failed: ${response.status} ${payload?.retMsg || "unknown error"}`);
    }
    instruments.push(...(payload?.result?.list || []));
    cursor = String(payload?.result?.nextPageCursor || "");
  } while (cursor);
  return instruments;
}

const requested = parseRequested(await readFile(inputPath, "utf8"));
const duplicates = [...new Set(requested.filter((symbol, index) => requested.indexOf(symbol) !== index))];
const uniqueRequested = [...new Set(requested)];
const instruments = await fetchLinearInstruments();
const allBySymbol = new Map(instruments.map((item) => [item.symbol, item]));
const availableSet = new Set(instruments.filter((item) => item.status === "Trading").map((item) => item.symbol));
const available = uniqueRequested.filter((symbol) => availableSet.has(symbol));
const unavailable = uniqueRequested.filter((symbol) => !availableSet.has(symbol));
const unavailableDetails = unavailable.map((symbol) => {
  const base = symbol.replace(/USDT$/, "");
  const exact = allBySymbol.get(symbol);
  const suggestions = instruments
    .map((item) => ({
      symbol: item.symbol,
      status: item.status,
      distance: editDistance(base, item.symbol.replace(/USDT$/, "")),
    }))
    .filter((item) => item.distance <= Math.max(2, Math.floor(base.length / 3)))
    .sort((a, b) => a.distance - b.distance || a.symbol.localeCompare(b.symbol))
    .slice(0, 5);
  return { symbol, exactStatus: exact?.status || null, suggestions };
});
const diagnosticKeywords = ["CU", "COP", "SHIB", "RAY", "LOB", "LIFE", "SKH", "AMD", "PUMP", "FET", "ASI", "SYN", "ONE"];
const keywordMatches = Object.fromEntries(diagnosticKeywords.map((keyword) => [
  keyword,
  instruments
    .filter((item) => item.symbol.includes(keyword))
    .map((item) => ({ symbol: item.symbol, status: item.status })),
]));

const validationReport = {
  checkedAt: new Date().toISOString(),
  apiBase: API_BASE,
  requestedCount: requested.length,
  uniqueRequestedCount: uniqueRequested.length,
  duplicateSymbols: duplicates,
  bybitLinearTradingCount: availableSet.size,
  availableCount: available.length,
  available,
  unavailableCount: unavailable.length,
  unavailable,
  unavailableDetails,
  keywordMatches,
};

if (!process.argv.includes("--scan")) {
  console.log(JSON.stringify(validationReport, null, 2));
} else {
  console.log(JSON.stringify({
    validationSummary: {
      checkedAt: validationReport.checkedAt,
      requested: validationReport.requestedCount,
      uniqueRequested: validationReport.uniqueRequestedCount,
      duplicates: validationReport.duplicateSymbols,
      exactAvailable: validationReport.availableCount,
      unavailable: validationReport.unavailable,
    },
  }, null, 2));
}

if (process.argv.includes("--scan")) {
  const scannerBase = String(process.env.SCANNER_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
  const statusResponse = await fetch(`${scannerBase}/api/status`, { signal: AbortSignal.timeout(30_000) });
  const status = await statusResponse.json();
  if (!statusResponse.ok || !status.connected) throw new Error(`Scanner is unavailable: ${status.message || statusResponse.status}`);
  const universeResponse = await fetch(`${scannerBase}/api/symbols`, { signal: AbortSignal.timeout(10_000) });
  const universe = await universeResponse.json();
  if (!universeResponse.ok) throw new Error(`Could not load scanner universe: ${universe.message || universeResponse.status}`);
  const createResponse = await fetch(`${scannerBase}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ categories: universe.categories.map((item) => item.name) }),
    signal: AbortSignal.timeout(10_000),
  });
  let job = await createResponse.json();
  if (!createResponse.ok) throw new Error(`Could not start scanner job: ${job.message || createResponse.status}`);
  while (job.status === "queued" || job.status === "running") {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const pollResponse = await fetch(`${scannerBase}/api/scan/${job.id}`, { signal: AbortSignal.timeout(10_000) });
    job = await pollResponse.json();
    if (!pollResponse.ok) throw new Error(`Could not poll scanner job: ${job.message || pollResponse.status}`);
  }
  const failureKinds = job.errors.reduce((counts, error) => {
    const message = String(error.message || "");
    const kind = /10006|rate limit|too many visits/i.test(message)
      ? "rateLimit"
      : /closed daily bars/i.test(message)
        ? "insufficientDailyHistory"
        : /closed (15m|30m|1H|2H|4H) bars/i.test(message)
          ? "insufficientIntradayHistory"
          : "other";
    counts[kind] = (counts[kind] || 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({
    scannerSmokeTest: {
      status: job.status,
      configured: universe.count,
      groups: universe.categories,
      scanned: job.scanned,
      failed: job.failed,
      failureKinds,
      matches: job.results.length,
      sampleErrors: job.errors.slice(0, 10),
      message: job.message,
    },
  }, null, 2));
  if (job.status !== "complete") process.exitCode = 1;
}
