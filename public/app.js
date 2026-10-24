const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  connected: false,
  categories: [],
  selectedCategories: new Set(),
  results: [],
  selectedSymbol: null,
  side: "all",
  search: "",
  sort: "distance",
  range: 132,
  jobId: null,
  pollTimer: null,
};

const colors = {
  grid: "rgba(148,174,193,.11)", text: "#718999", up: "#45d6a5", down: "#fb7185",
  ema: "#f4c95d",
};

const els = {
  connectionCard: $("#connectionCard"), connectionLabel: $("#connectionLabel"), connectionHint: $("#connectionHint"),
  retryButton: $("#retryButton"), universeCount: $("#universeCount"), categoryList: $("#categoryList"),
  scanButton: $("#scanButton"), scanButtonLabel: $("#scanButtonLabel"), progress: $("#progress"),
  progressBar: $("#progressBar"), progressText: $("#progressText"), progressValue: $("#progressValue"),
  candidateCount: $("#candidateCount"), longCount: $("#longCount"), shortCount: $("#shortCount"),
  scannedCount: $("#scannedCount"), searchInput: $("#searchInput"), sideFilters: $("#sideFilters"),
  sortButton: $("#sortButton"), resultList: $("#resultList"), emptyState: $("#emptyState"), detailContent: $("#detailContent"),
  priceChart: $("#priceChart"), priceTooltip: $("#priceTooltip"),
  rangeButtons: $("#rangeButtons"), toast: $("#toast"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `${response.status} ${response.statusText}`);
  return payload;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { els.toast.hidden = true; }, 7000);
}

function setConnection(connected, message) {
  state.connected = connected;
  els.connectionCard.classList.toggle("online", connected);
  els.connectionCard.classList.toggle("offline", !connected);
  els.connectionLabel.textContent = connected ? "Bybit 公共行情已连接" : "Bybit 公共行情未连接";
  els.connectionHint.textContent = connected ? "只读行情通道 · Public V5 API" : (message || "请检查网络或 Bybit API 地址");
  els.scanButton.disabled = !connected;
  els.scanButtonLabel.textContent = connected ? "开始扫描" : "等待 Bybit 行情";
}

async function connect() {
  els.retryButton.disabled = true;
  els.connectionCard.className = "connection-card";
  els.connectionLabel.textContent = "正在检测 Bybit";
  els.connectionHint.textContent = "api.bybit.com · Public V5";
  try {
    const status = await api("/api/status");
    if (!status.connected) throw new Error("Bybit 公共行情接口不可用");
    setConnection(true);
    await loadUniverse();
  } catch (error) {
    setConnection(false, shortError(error));
    els.categoryList.innerHTML = `<div class="empty-mini">请检查网络、Bybit API 地址和 config/symbols.json</div>`;
    els.universeCount.textContent = "离线";
  } finally {
    els.retryButton.disabled = false;
  }
}

async function loadUniverse() {
  const payload = await api("/api/symbols");
  state.categories = payload.categories;
  state.selectedCategories = new Set(payload.categories.map((category) => category.name));
  els.universeCount.textContent = `${payload.count} 个品种`;
  renderCategories();
}

function renderCategories() {
  els.categoryList.innerHTML = state.categories.map((category) => `
    <label class="category-chip">
      <input type="checkbox" value="${escapeHtml(category.name)}" ${state.selectedCategories.has(category.name) ? "checked" : ""}>
      <span>${escapeHtml(category.name)} <small>${category.count}</small></span>
    </label>`).join("");
  els.categoryList.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selectedCategories.add(input.value);
      else state.selectedCategories.delete(input.value);
      els.scanButton.disabled = !state.connected || state.selectedCategories.size === 0;
    });
  });
}

async function startScan() {
  if (!state.connected || !state.selectedCategories.size) return;
  clearTimeout(state.pollTimer);
  state.results = [];
  state.selectedSymbol = null;
  els.emptyState.hidden = false;
  els.detailContent.hidden = true;
  els.scanButton.disabled = true;
  els.scanButtonLabel.textContent = "扫描中…";
  els.progress.hidden = false;
  updateProgress({ scanned: 0, total: 0, current: "读取 Bybit 交易对配置" });
  renderResults();
  try {
    const job = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({ categories: [...state.selectedCategories] }),
    });
    state.jobId = job.id;
    await pollScan();
  } catch (error) {
    finishScan();
    toast(`无法开始扫描：${shortError(error)}`);
  }
}

async function pollScan() {
  if (!state.jobId) return;
  try {
    const job = await api(`/api/scan/${state.jobId}`);
    state.results = job.results || [];
    updateProgress(job);
    renderSummary(job.scanned || 0);
    renderResults();
    if (!state.selectedSymbol && state.results.length) selectSymbol(state.results[0].symbol);
    if (job.status === "complete") {
      finishScan();
      if (job.failed) toast(`扫描完成；${job.failed} 个品种因历史数据不足或接口返回异常而跳过。`);
      return;
    }
    if (job.status === "failed") throw new Error(job.message || "扫描失败");
    state.pollTimer = setTimeout(pollScan, 650);
  } catch (error) {
    finishScan();
    toast(`扫描中断：${shortError(error)}`);
  }
}

function finishScan() {
  state.jobId = null;
  els.scanButton.disabled = !state.connected || !state.selectedCategories.size;
  els.scanButtonLabel.textContent = "再次扫描";
  renderResults();
  setTimeout(() => { els.progress.hidden = true; }, 1800);
}

function updateProgress(job) {
  const total = job.total || 0;
  const scanned = job.scanned || 0;
  const percent = total ? Math.min(100, Math.round(scanned / total * 100)) : 2;
  els.progressBar.style.width = `${percent}%`;
  els.progressValue.textContent = total ? `${percent}%` : "准备";
  els.progressText.textContent = total ? `${scanned} / ${total} · ${job.current || "整理结果"}` : (job.current || "读取品种");
}

function renderSummary(scanned) {
  const longs = state.results.filter((item) => item.side === "long").length;
  const shorts = state.results.filter((item) => item.side === "short").length;
  els.candidateCount.textContent = state.results.length;
  els.longCount.textContent = longs;
  els.shortCount.textContent = shorts;
  els.scannedCount.textContent = scanned;
}

function filteredResults() {
  const query = state.search.toLowerCase();
  return state.results
    .filter((item) => state.side === "all" || item.side === state.side)
    .filter((item) => !query || `${item.symbol} ${item.name} ${item.category}`.toLowerCase().includes(query))
    .sort((a, b) => state.sort === "symbol" ? a.symbol.localeCompare(b.symbol) : Math.abs(a.emaDistancePct) - Math.abs(b.emaDistancePct));
}

function renderResults() {
  const rows = filteredResults();
  if (!rows.length) {
    els.resultList.innerHTML = `<div class="empty-mini">${state.jobId ? "正在寻找符合 EMA 条件的品种…" : "暂无匹配结果"}</div>`;
    return;
  }
  els.resultList.innerHTML = rows.map((item) => `
    <button class="result-row ${item.side === "short" ? "short" : ""} ${item.symbol === state.selectedSymbol ? "active" : ""}" type="button" data-symbol="${escapeHtml(item.symbol)}">
      <span><strong>${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.category)} · ${escapeHtml(item.name)}</small></span>
      <span class="row-side"><b>${item.side === "long" ? "多 LONG" : "空 SHORT"}</b><small>D ${formatPct(item.emaDistancePct)} · ${escapeHtml(item.qualifyingTimeframes.join(" / "))}</small></span>
    </button>`).join("");
  els.resultList.querySelectorAll(".result-row").forEach((row) => row.addEventListener("click", () => selectSymbol(row.dataset.symbol)));
}

function selectSymbol(symbol) {
  const item = state.results.find((result) => result.symbol === symbol);
  if (!item) return;
  state.selectedSymbol = symbol;
  els.emptyState.hidden = true;
  els.detailContent.hidden = false;
  $("#detailCategory").textContent = item.category.toUpperCase();
  $("#detailSymbol").textContent = item.symbol;
  $("#detailName").textContent = item.name;
  $("#detailClose").textContent = formatPrice(item.close);
  $("#detailChange").textContent = formatPct(item.changePct);
  $("#detailChange").className = item.changePct >= 0 ? "positive" : "negative";
  $("#detailDate").textContent = `收盘 · ${item.asOf}`;
  $("#signalBadge").textContent = item.side === "long" ? "多头 LONG" : "空头 SHORT";
  $("#signalBadge").className = `signal-badge ${item.side === "short" ? "short" : ""}`;
  const distance = item.emaDistancePct;
  $("#emaDistance").textContent = formatPct(distance);
  $("#emaDistance").className = distance >= 0 ? "positive" : "negative";
  $("#emaValue").textContent = `EMA21 ${formatPrice(item.ema21)}`;
  $("#dailyNoTouch").textContent = item.dailyNoTouch ? "2 / 2" : "未通过";
  $("#dailyNoTouch").className = item.dailyNoTouch ? "positive" : "negative";
  renderTouchMetric(item, "15m", "#touch15m", "#touch15mMeta");
  renderTouchMetric(item, "30m", "#touch30m", "#touch30mMeta");
  renderTouchMetric(item, "1H", "#touch1h", "#touch1hMeta");
  renderTouchMetric(item, "2H", "#touch2h", "#touch2hMeta");
  renderTouchMetric(item, "4H", "#touch4h", "#touch4hMeta");
  $("#statusValue").textContent = item.side === "long" ? "多头通过" : "空头通过";
  $("#statusValue").className = item.side === "long" ? "positive" : "negative";
  renderResults();
  requestAnimationFrame(drawCharts);
}

function renderTouchMetric(item, timeframe, valueSelector, metaSelector) {
  const confirmation = item.confirmations.find((entry) => entry.timeframe === timeframe);
  const value = $(valueSelector);
  const meta = $(metaSelector);
  if (!confirmation?.passed) {
    value.textContent = "未触碰";
    value.className = "";
    meta.textContent = `近 3 根无触碰 · ${confirmation?.asOf || "—"}`;
    return;
  }
  value.textContent = confirmation.touchedPeriods.map((period) => `EMA${period}`).join(" / ");
  value.className = "positive";
  const ago = confirmation.lastTouchBarsAgo === 0 ? "最近一根" : `${confirmation.lastTouchBarsAgo} 根前`;
  meta.textContent = `${ago} · ${confirmation.lastTouchAt || confirmation.asOf}`;
}

function selectedItem() {
  return state.results.find((item) => item.symbol === state.selectedSymbol);
}

function visibleBars() {
  const bars = selectedItem()?.bars || [];
  return state.range ? bars.slice(-state.range) : bars;
}

function setupCanvas(canvas) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, width: rect.width, height: rect.height };
}

function chartArea(width, height) {
  return { left: 54, right: width - 16, top: 13, bottom: height - 25 };
}

function drawGrid(ctx, area, min, max, steps = 4, formatter = formatPrice) {
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let index = 0; index <= steps; index += 1) {
    const y = area.top + (area.bottom - area.top) * index / steps;
    const value = max - (max - min) * index / steps;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath(); ctx.moveTo(area.left, y); ctx.lineTo(area.right, y); ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(formatter(value), area.left - 8, y);
  }
}

function drawLine(ctx, points, color, width = 1.3) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  let started = false;
  for (const [x, y] of points) {
    if (!Number.isFinite(y)) { started = false; continue; }
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawPrice() {
  const bars = visibleBars();
  if (!bars.length) return;
  const { ctx, width, height } = setupCanvas(els.priceChart);
  const area = chartArea(width, height);
  const values = bars.flatMap((bar) => [bar.h, bar.l, bar.e21]).filter(Number.isFinite);
  let min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * .07, Math.abs(max) * .001);
  min -= padding; max += padding;
  const x = (index) => area.left + (area.right - area.left) * (index + .5) / bars.length;
  const y = (value) => area.top + (max - value) / (max - min) * (area.bottom - area.top);
  drawGrid(ctx, area, min, max, 4);
  const candleWidth = Math.max(1, Math.min(8, (area.right - area.left) / bars.length * .58));
  bars.forEach((bar, index) => {
    const color = bar.c >= bar.o ? colors.up : colors.down;
    const cx = x(index);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, y(bar.h)); ctx.lineTo(cx, y(bar.l)); ctx.stroke();
    const top = y(Math.max(bar.o, bar.c));
    const bottom = y(Math.min(bar.o, bar.c));
    ctx.fillRect(cx - candleWidth / 2, top, candleWidth, Math.max(1, bottom - top));
  });
  drawLine(ctx, bars.map((bar, index) => [x(index), Number.isFinite(bar.e21) ? y(bar.e21) : NaN]), colors.ema, 1.5);
  drawDates(ctx, bars, area, x);
  els.priceChart._chart = { bars, area, x, y };
}

function drawDates(ctx, bars, area, x) {
  const indexes = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
  ctx.fillStyle = colors.text;
  ctx.font = "9px ui-monospace, monospace";
  ctx.textBaseline = "top";
  indexes.forEach((index, position) => {
    ctx.textAlign = position === 0 ? "left" : position === 2 ? "right" : "center";
    ctx.fillText(bars[index]?.t?.slice(5) || "", x(index), area.bottom + 8);
  });
}

function drawCharts() { drawPrice(); }

function bindTooltip(canvas, tooltip) {
  canvas.addEventListener("mousemove", (event) => {
    const chart = canvas._chart;
    if (!chart?.bars?.length) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const ratio = (mouseX - chart.area.left) / Math.max(1, chart.area.right - chart.area.left);
    const index = Math.max(0, Math.min(chart.bars.length - 1, Math.round(ratio * (chart.bars.length - 1))));
    const bar = chart.bars[index];
    tooltip.innerHTML = `<b>${bar.t}</b><br>O ${formatPrice(bar.o)} · H ${formatPrice(bar.h)}<br>L ${formatPrice(bar.l)} · C ${formatPrice(bar.c)}<br><span style="color:${colors.ema}">EMA21 ${Number.isFinite(bar.e21) ? formatPrice(bar.e21) : "—"}</span>`;
    tooltip.hidden = false;
    const maxLeft = rect.width - tooltip.offsetWidth - 8;
    tooltip.style.left = `${Math.max(8, Math.min(maxLeft, mouseX + 12))}px`;
    tooltip.style.top = "10px";
  });
  canvas.addEventListener("mouseleave", () => { tooltip.hidden = true; });
}

function formatPrice(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const digits = Math.abs(number) < 2 ? 5 : Math.abs(number) < 100 ? 3 : 2;
  return number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function formatPct(value) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%` : "—"; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function shortError(error) { return String(error?.message || error).replace(/^Bybit HTTP \d+:\s*/, "").slice(0, 180); }

els.retryButton.addEventListener("click", connect);
els.scanButton.addEventListener("click", startScan);
els.searchInput.addEventListener("input", () => { state.search = els.searchInput.value.trim(); renderResults(); });
els.sideFilters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-side]");
  if (!button) return;
  state.side = button.dataset.side;
  $$("#sideFilters button").forEach((item) => item.classList.toggle("active", item === button));
  renderResults();
});
els.sortButton.addEventListener("click", () => {
  state.sort = state.sort === "distance" ? "symbol" : "distance";
  els.sortButton.textContent = state.sort === "distance" ? "|距 EMA21| ↑" : "品种 A→Z";
  renderResults();
});
els.rangeButtons.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button) return;
  state.range = Number(button.dataset.range);
  $$("#rangeButtons button").forEach((item) => item.classList.toggle("active", item === button));
  drawCharts();
});
bindTooltip(els.priceChart, els.priceTooltip);
window.addEventListener("resize", () => { clearTimeout(window._chartResize); window._chartResize = setTimeout(drawCharts, 120); });

connect();
