import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createScannerServer } from "../server.mjs";

const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const outputPath = resolve(argumentsMap.get("output") || "automation-state/latest.json");
const notificationPath = resolve(argumentsMap.get("notification") || "automation-state/notification.md");
const now = new Date();
const singaporeParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Singapore",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
}).formatToParts(now).map((part) => [part.type, part.value]));
const singaporeDate = `${singaporeParts.year}-${singaporeParts.month}-${singaporeParts.day}`;
const singaporeTime = `${singaporeParts.hour}:${singaporeParts.minute}:${singaporeParts.second}`;

function requestJson(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(45_000), ...options }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `${response.status} ${response.statusText}`);
    return payload;
  });
}

async function waitForJob(baseUrl, job) {
  const deadline = Date.now() + 20 * 60_000;
  let current = job;
  while (["queued", "running"].includes(current.status)) {
    if (Date.now() >= deadline) throw new Error(`Scanner job ${current.id} timed out`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    current = await requestJson(`${baseUrl}/api/scan/${current.id}`);
  }
  if (current.status !== "complete") throw new Error(current.message || `Scanner job ended with ${current.status}`);
  return current;
}

function opportunityRows(results) {
  return results.map((item) => ({
    symbol: item.symbol,
    side: item.side,
    selectedTimeframe: item.selectedTimeframe,
    previousLrc25: item.selectedPreviousLrc25Angle,
    selectedLrc25: item.selectedLrc25Angle,
    matchedTimeframes: item.matchedTimeframes,
  }));
}

function opportunityMarkdown(results) {
  if (!results.length) return "本次没有发现与日线 LRC25 方向相反的周期。";
  const rows = results.map((item) => (
    `| ${item.symbol} | ${item.selectedTimeframe} | ${item.side} | ${Number(item.selectedPreviousLrc25Angle).toFixed(6)}° | ${Number(item.selectedLrc25Angle).toFixed(6)}° |`
  ));
  return [
    "| Symbol | Timeframe | Opportunity | Previous LRC25 | Current LRC25 |",
    "|---|---:|---|---:|---:|",
    ...rows,
  ].join("\n");
}

const server = createScannerServer();
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const universe = await requestJson(`${baseUrl}/api/symbols?source=okx`);
  const created = await requestJson(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "okx", categories: universe.categories.map((item) => item.name) }),
  });
  const job = await waitForJob(baseUrl, created);
  const opportunities = opportunityRows(job.results);
  const latest = {
    date: singaporeDate,
    time: singaporeTime,
    generatedAt: now.toISOString(),
    mode: "full",
    status: "complete",
    configured: universe.configuredCount,
    available: universe.count,
    unavailable: universe.unavailableCount,
    total: job.total,
    scanned: job.scanned,
    failed: job.failed,
    skippedUnavailable: job.skippedUnavailable,
    matches: opportunities.length,
    opportunities,
    errors: job.errors,
    notify: opportunities.length > 0,
  };
  const notification = [
    `## OKX LRC25 反向减弱机会｜${singaporeDate} ${singaporeTime} SGT`,
    "",
    opportunityMarkdown(job.results),
  ].join("\n");
  await writeFile(outputPath, `${JSON.stringify(latest, null, 2)}\n`);
  await writeFile(notificationPath, notification);
  console.log(JSON.stringify(latest));
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
