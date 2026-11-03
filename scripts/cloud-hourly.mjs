import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createScannerServer } from "../server.mjs";

const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const mode = argumentsMap.get("mode") || "weakening";
const baselinePath = resolve(argumentsMap.get("baseline") || "automation-state/baseline.json");
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

if (!["full", "weakening"].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);

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

function weakeningRows(results) {
  return results.map((item) => ({
    symbol: item.symbol,
    side: item.side,
    selectedTimeframe: item.selectedTimeframe,
    previousLrc6: item.selectedPreviousLrc6Angle,
    currentLrc6: item.selectedLrc6Angle,
  }));
}

function weakeningMarkdown(results) {
  if (!results.length) return "本次没有交易对出现 LRC6 数值减弱。";
  const rows = results.map((item) => (
    `| ${item.symbol} | ${item.side} | ${item.selectedTimeframe} | ${Number(item.selectedPreviousLrc6Angle).toFixed(6)}° | ${Number(item.selectedLrc6Angle).toFixed(6)}° |`
  ));
  return [
    "| Symbol | Side | Timeframe | Previous LRC6 | Current LRC6 |",
    "|---|---|---:|---:|---:|",
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
  let latest;
  let notification = "";
  if (mode === "full") {
    const universe = await requestJson(`${baseUrl}/api/symbols?source=okx`);
    const created = await requestJson(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "okx", categories: universe.categories.map((item) => item.name) }),
    });
    const job = await waitForJob(baseUrl, created);
    const candidates = job.results.map((item) => ({
      symbol: item.symbol,
      side: item.side,
      selectedTimeframe: item.selectedTimeframe,
    }));
    const weakening = job.results.filter((item) => item.selectedLrc6Weakening);
    const baseline = {
      date: singaporeDate,
      createdAt: now.toISOString(),
      source: "okx",
      candidates,
    };
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    latest = {
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
      matches: job.results.length,
      baselineCandidates: candidates.length,
      weakening: weakeningRows(weakening),
      errors: job.errors,
      notify: weakening.length > 0,
    };
    notification = [
      `## OKX LRC6 减弱｜${singaporeDate} ${singaporeTime} SGT`,
      "",
      weakeningMarkdown(weakening),
    ].filter(Boolean).join("\n");
  } else {
    let baseline;
    try {
      baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    } catch {
      baseline = null;
    }
    if (!baseline || baseline.date !== singaporeDate || !Array.isArray(baseline.candidates)) {
      latest = {
        date: singaporeDate,
        time: singaporeTime,
        generatedAt: now.toISOString(),
        mode: "weakening",
        status: "baseline-missing",
        baselineDate: baseline?.date || null,
        weakening: [],
        notify: false,
      };
    } else {
      const created = await requestJson(`${baseUrl}/api/weakening-check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "okx", candidates: baseline.candidates }),
      });
      const job = await waitForJob(baseUrl, created);
      latest = {
        date: singaporeDate,
        time: singaporeTime,
        generatedAt: now.toISOString(),
        mode: "weakening",
        status: "complete",
        baselineDate: baseline.date,
        baselineCandidates: baseline.candidates.length,
        total: job.total,
        scanned: job.scanned,
        failed: job.failed,
        weakening: weakeningRows(job.results),
        errors: job.errors,
        notify: job.results.length > 0,
      };
      notification = [
        `## OKX LRC6 减弱｜${singaporeDate} ${singaporeTime} SGT`,
        "",
        `仅复查 ${baseline.candidates.length} 个当日基线候选的已选周期；扫描 ${job.scanned}/${job.total}，失败 ${job.failed}，减弱 ${job.results.length}。`,
        "",
        weakeningMarkdown(job.results),
      ].join("\n");
    }
  }
  await writeFile(outputPath, `${JSON.stringify(latest, null, 2)}\n`);
  await writeFile(notificationPath, notification);
  console.log(JSON.stringify(latest));
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
