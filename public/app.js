const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  source: "bybit",
  connected: false,
  categories: [],
  selectedCategories: new Set(),
  results: [],
  selectedSymbol: null,
  side: "all",
  search: "",
  sort: "distance",
  jobId: null,
  pollTimer: null,
};

const els = {
  connectionCard: $("#connectionCard"), connectionLabel: $("#connectionLabel"), connectionHint: $("#connectionHint"),
  retryButton: $("#retryButton"), universeCount: $("#universeCount"), categoryList: $("#categoryList"),
  scanButton: $("#scanButton"), scanButtonLabel: $("#scanButtonLabel"), progress: $("#progress"),
  progressBar: $("#progressBar"), progressText: $("#progressText"), progressValue: $("#progressValue"),
  candidateCount: $("#candidateCount"), longCount: $("#longCount"), shortCount: $("#shortCount"),
  scannedCount: $("#scannedCount"), searchInput: $("#searchInput"), sideFilters: $("#sideFilters"),
  sortButton: $("#sortButton"), resultList: $("#resultList"), emptyState: $("#emptyState"), detailContent: $("#detailContent"),
  weakeningCount: $("#weakeningCount"), weakeningList: $("#weakeningList"), toast: $("#toast"),
  sourceSwitch: $("#sourceSwitch"),
};

const sourceCopy = {
  bybit: { name: "Bybit", connected: "Bybit 公共行情已连接", waiting: "正在检测 Bybit", hint: "api.bybit.com · Public V5" },
  binance: { name: "Binance", connected: "Binance Futures 已连接", waiting: "正在检测 Binance Futures", hint: "fapi.binance.com · USDⓈ-M" },
  okx: { name: "OKX", connected: "OKX 永续合约行情已连接", waiting: "正在检测 OKX", hint: "openapi.okx.com · USDT Perpetual" },
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
  const copy = sourceCopy[state.source];
  state.connected = connected;
  els.connectionCard.classList.toggle("online", connected);
  els.connectionCard.classList.toggle("offline", !connected);
  els.connectionLabel.textContent = connected ? copy.connected : `${copy.name} 公共行情未连接`;
  els.connectionHint.textContent = connected ? `只读行情通道 · ${copy.hint}` : (message || `请检查网络或 ${copy.name} API 地址`);
  els.scanButton.disabled = !connected || state.selectedCategories.size === 0;
  els.scanButtonLabel.textContent = connected ? "开始扫描" : `等待 ${copy.name} 行情`;
}

async function connect() {
  const requestedSource = state.source;
  const copy = sourceCopy[requestedSource];
  els.retryButton.disabled = true;
  els.connectionCard.className = "connection-card";
  els.connectionLabel.textContent = copy.waiting;
  els.connectionHint.textContent = copy.hint;
  try {
    const status = await api(`/api/status?source=${encodeURIComponent(requestedSource)}`);
    if (requestedSource !== state.source) return;
    if (!status.connected) throw new Error(`${copy.name} 公共行情接口不可用`);
    setConnection(true);
    await loadUniverse();
  } catch (error) {
    if (requestedSource !== state.source) return;
    setConnection(false, shortError(error));
    els.categoryList.innerHTML = `<div class="empty-mini">请检查网络、${copy.name} API 地址和 config/symbols.json</div>`;
    els.universeCount.textContent = "离线";
  } finally {
    els.retryButton.disabled = false;
  }
}

async function loadUniverse() {
  const payload = await api(`/api/symbols?source=${encodeURIComponent(state.source)}`);
  state.categories = payload.categories;
  state.selectedCategories = new Set(payload.categories.map((category) => category.name));
  els.universeCount.textContent = payload.unavailableCount
    ? `${payload.count} / ${payload.configuredCount} 个品种`
    : `${payload.count} 个品种`;
  renderCategories();
  els.scanButton.disabled = !state.connected || state.selectedCategories.size === 0;
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
  els.sourceSwitch.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  els.scanButtonLabel.textContent = "扫描中…";
  els.progress.hidden = false;
  updateProgress({ scanned: 0, total: 0, current: `读取 ${sourceCopy[state.source].name} 交易对配置` });
  renderResults();
  renderWeakeningResults();
  try {
    const job = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({ source: state.source, categories: [...state.selectedCategories] }),
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
    renderWeakeningResults();
    if (!state.selectedSymbol && state.results.length) selectSymbol(state.results[0].symbol);
    if (job.status === "complete") {
      finishScan();
      if (job.failed) toast(`扫描完成；${job.failed} 个品种因历史数据不足或接口返回异常而跳过。`);
      else if (job.skippedUnavailable) toast(`扫描完成；${job.skippedUnavailable} 个配置品种在当前数据源没有可交易合约，已跳过。`);
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
  els.sourceSwitch.querySelectorAll("button").forEach((button) => { button.disabled = false; });
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
  const weakening = state.results.filter((item) => item.selectedLrc6Weakening).length;
  els.candidateCount.textContent = state.results.length;
  els.longCount.textContent = longs;
  els.shortCount.textContent = shorts;
  els.scannedCount.textContent = scanned;
  els.weakeningCount.textContent = weakening;
}

function filteredResults() {
  const query = state.search.toLowerCase();
  const dailyDistance = (item) => Number.isFinite(Number(item.dailyEma21DistancePct))
    ? Number(item.dailyEma21DistancePct)
    : Math.abs(Number(item.emaDistancePct));
  return state.results
    .filter((item) => state.side === "all" || item.side === state.side)
    .filter((item) => !query || `${item.symbol} ${item.name} ${item.category}`.toLowerCase().includes(query))
    .sort((a, b) => state.sort === "symbol"
      ? a.symbol.localeCompare(b.symbol)
      : dailyDistance(a) - dailyDistance(b) || a.symbol.localeCompare(b.symbol));
}

function renderResults() {
  const rows = filteredResults();
  if (!rows.length) {
    els.resultList.innerHTML = `<div class="empty-mini">${state.jobId ? "正在寻找符合 LRC25 条件的品种…" : "暂无匹配结果"}</div>`;
    return;
  }
  els.resultList.innerHTML = rows.map((item) => `
    <button class="result-row ${item.side === "short" ? "short" : ""} ${item.symbol === state.selectedSymbol ? "active" : ""}" type="button" data-symbol="${escapeHtml(item.symbol)}">
      <span><strong>${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.category)} · ${escapeHtml(item.name)}</small></span>
      <span class="row-side"><b>D${item.side === "long" ? "多" : "空"} · ${escapeHtml(item.selectedTimeframe)}</b><small>距D1 EMA21 ${formatAbsPct(item.dailyEma21DistancePct ?? item.emaDistancePct)} · LRC25 ${formatAngle(item.selectedLrc25Angle)} · LRC6 ${formatAngle(item.selectedLrc6Angle)}</small></span>
    </button>`).join("");
  els.resultList.querySelectorAll(".result-row").forEach((row) => row.addEventListener("click", () => selectSymbol(row.dataset.symbol)));
}

function renderWeakeningResults() {
  const rows = state.results.filter((item) => item.selectedLrc6Weakening);
  els.weakeningCount.textContent = rows.length;
  if (!rows.length) {
    els.weakeningList.innerHTML = `<div class="empty-mini">${state.jobId ? "正在检测 LRC6 是否减弱…" : "暂无 LRC6 减弱结果"}</div>`;
    return;
  }
  els.weakeningList.innerHTML = rows.map((item) => `
    <button class="result-row weakening-row ${item.side === "short" ? "short" : ""} ${item.symbol === state.selectedSymbol ? "active" : ""}" type="button" data-symbol="${escapeHtml(item.symbol)}">
      <span><strong>${escapeHtml(item.symbol)}</strong><small>D${item.side === "long" ? "多" : "空"} · ${escapeHtml(item.selectedTimeframe)}</small></span>
      <span class="row-side"><b>LRC6 减弱</b><small>${formatAngle(item.selectedPreviousLrc6Angle)} → ${formatAngle(item.selectedLrc6Angle)}</small></span>
    </button>`).join("");
  els.weakeningList.querySelectorAll(".result-row").forEach((row) => row.addEventListener("click", () => selectSymbol(row.dataset.symbol)));
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
  $("#signalBadge").textContent = `D${item.side === "long" ? "多" : "空"} · ${item.selectedTimeframe} LRC6${item.selectedLrc6Side === "long" ? "多" : "空"}`;
  $("#signalBadge").className = `signal-badge ${item.side === "short" ? "short" : ""}`;
  const distance = item.emaDistancePct;
  $("#emaDistance").textContent = formatPct(distance);
  $("#emaDistance").className = distance >= 0 ? "positive" : "negative";
  $("#emaValue").textContent = `EMA21 ${formatPrice(item.ema21)}`;
  $("#dailyNoTouch").textContent = item.dailyNoTouch ? "2 / 2" : "未通过";
  $("#dailyNoTouch").className = item.dailyNoTouch ? "positive" : "negative";
  $("#lrcTimeframe").textContent = item.selectedTimeframe || "—";
  $("#lrc25Signal").textContent = item.selectedLrc25Side === "long" ? "多 LONG" : "空 SHORT";
  $("#lrc25Signal").className = item.selectedLrc25Side === "long" ? "positive" : "negative";
  $("#lrc25Meta").textContent = `LRC25 角度 ${formatAngle(item.selectedLrc25Angle)}`;
  $("#lrc6Signal").textContent = item.selectedLrc6Side === "long" ? "多 LONG" : "空 SHORT";
  $("#lrc6Signal").className = item.selectedLrc6Side === "long" ? "positive" : "negative";
  $("#lrc6Meta").textContent = item.selectedLrc6Weakening
    ? `减弱：${formatAngle(item.selectedPreviousLrc6Angle)} → ${formatAngle(item.selectedLrc6Angle)}`
    : `前值 ${formatAngle(item.selectedPreviousLrc6Angle)} · 当前 ${formatAngle(item.selectedLrc6Angle)}`;
  $("#statusValue").textContent = `LRC25${item.selectedLrc25Side === "long" ? "多" : "空"} / LRC6${item.selectedLrc6Side === "long" ? "多" : "空"}`;
  $("#statusValue").className = item.side === "long" ? "positive" : "negative";
  renderResults();
  renderWeakeningResults();
}

function formatPrice(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const digits = Math.abs(number) < 2 ? 5 : Math.abs(number) < 100 ? 3 : 2;
  return number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function formatPct(value) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%` : "—"; }
function formatAbsPct(value) { return Number.isFinite(Number(value)) ? `${Math.abs(Number(value)).toFixed(2)}%` : "—"; }
function formatAngle(value) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}°` : "—"; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function shortError(error) { return String(error?.message || error).replace(/^Bybit HTTP \d+:\s*/, "").slice(0, 180); }

els.retryButton.addEventListener("click", connect);
els.sourceSwitch.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-source]");
  if (!button || button.dataset.source === state.source || state.jobId) return;
  state.source = button.dataset.source;
  els.sourceSwitch.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
  state.results = [];
  state.selectedSymbol = null;
  state.categories = [];
  state.selectedCategories = new Set();
  renderSummary(0);
  renderResults();
  renderWeakeningResults();
  els.emptyState.hidden = false;
  els.detailContent.hidden = true;
  connect();
});
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
  els.sortButton.textContent = state.sort === "distance" ? "距D1 EMA21：近→远" : "品种 A→Z";
  renderResults();
  renderWeakeningResults();
});

connect();
