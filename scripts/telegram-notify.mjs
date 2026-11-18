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
const opportunities = Array.isArray(latest.opportunities) ? latest.opportunities : [];

if (!latest.notify || opportunities.length === 0) {
  console.log("No LRC25 reversal opportunities; skipping Telegram notification.");
  process.exit(0);
}

const sideLabel = (side) => side === "long" ? "多" : side === "short" ? "空" : side;
const angle = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}°` : "—";
const header = `OKX LRC25 反向减弱机会 | ${latest.date} ${latest.time} SGT`;
const lines = opportunities.map((item) => [
  item.symbol,
  `${item.selectedTimeframe}${sideLabel(item.side)}机会`,
  `LRC25 ${angle(item.previousLrc25)} → ${angle(item.selectedLrc25)}`,
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

console.log(`Sent ${opportunities.length} LRC25 opportunity pair(s) in ${messages.length} Telegram message(s).`);
