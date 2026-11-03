import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const inputPath = resolve(process.argv[2] || "automation-state/latest.json");
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

if (!token || !chatId) {
  console.log("Telegram secrets are not configured; skipping notification.");
  process.exit(0);
}

const latest = JSON.parse(await readFile(inputPath, "utf8"));
const weakening = Array.isArray(latest.weakening) ? latest.weakening : [];

if (!latest.notify || weakening.length === 0) {
  console.log("No LRC6 weakening pairs; skipping Telegram notification.");
  process.exit(0);
}

const sideLabel = (side) => side === "long" ? "多" : side === "short" ? "空" : side;
const angle = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(6)}°` : "—";
const header = `OKX LRC6 数值减弱 | ${latest.date} ${latest.time} SGT`;
const lines = weakening.map((item) => [
  item.symbol,
  sideLabel(item.side),
  item.selectedTimeframe,
  `${angle(item.previousLrc6)} → ${angle(item.currentLrc6)}`,
].join(" | "));

const messages = [];
let current = header;
for (const line of lines) {
  const next = `${current}\n${line}`;
  if (next.length > 3900) {
    messages.push(current);
    current = `${header}（续）\n${line}`;
  } else {
    current = next;
  }
}
messages.push(current);

const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
for (const text of messages) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`Telegram sendMessage failed: ${payload.description || response.statusText}`);
  }
}

console.log(`Sent ${weakening.length} weakening pair(s) in ${messages.length} Telegram message(s).`);
