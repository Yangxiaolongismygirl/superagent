
  const APP_BUILD = "2026-11-14 02:45";
  const $ = (id) => document.getElementById(id);
  // 所有接口调用都留痕，出问题能追
  (function wrapFetch() {
    if (typeof window === "undefined" || !window.fetch) return;
    if (window.__fetchLogged) return;
    window.__fetchLogged = true;
    const raw = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : input?.url ?? "";
      const method = init?.method ?? "GET";
      if (!url.includes("/api/")) return raw(input, init);
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      try {
        const res = await raw(input, init);
        const ms = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started);
        const short = url.replace(location.origin, "");
        (res.ok ? logInfo : logErr)(`${method} ${short} → ${res.status} (${ms}ms)`);
        return res;
      } catch (error) {
        logErr(`${method} ${url} 失败：${error.message}`);
        throw error;
      }
    };
  })();


  // ---------- 操作日志 ----------
  const LOG_KEY = "autoloop.logs.v1";
  const LOG_MAX = 300;
  let logs = [];
  try { logs = JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem(LOG_KEY)) || "[]"); } catch { logs = []; }
  let dshOnline = false;

  function logLine(level, text) {
    const at = new Date();
    logs.push({ t: at.toLocaleTimeString("zh-CN", { hour12: false }), lv: level, tx: String(text).slice(0, 400) });
    if (logs.length > LOG_MAX) logs = logs.slice(-LOG_MAX);
    try { if (typeof localStorage !== "undefined") localStorage.setItem(LOG_KEY, JSON.stringify(logs)); } catch {}
    renderLog();
  }
  const logInfo = (t) => logLine("info", t);
  const logOk = (t) => logLine("ok", t);
  const logErr = (t) => logLine("err", t);

  function renderLog() {
    if (!$("logBody")) return;
    $("logCount").textContent = String(logs.length);
    const last = logs[logs.length - 1];
    $("logLast").textContent = last ? `${last.t} ${last.tx}` : "还没有记录";
    $("logBody").innerHTML = logs.slice(-80).reverse()
      .map((row) => `<div class="logrow"><span class="tm">${esc(row.t)}</span><span class="lv ${row.lv}">${{ info: "信息", ok: "成功", err: "错误" }[row.lv] ?? row.lv}</span><span class="tx">${esc(row.tx)}</span></div>`)
      .join("");
  }

  function toggleLog() {
    const bar = $("logBar");
    bar.classList.toggle("open");
    $("logToggle").textContent = bar.classList.contains("open") ? "收起 ▾" : "展开 ▴";
  }

  function clearLog() {
    logs = [];
    try { if (typeof localStorage !== "undefined") localStorage.removeItem(LOG_KEY); } catch {}
    renderLog();
  }


  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const stamp = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const span = (a, b) => {
    if (!a) return "";
    const ms = (b ? new Date(b) : new Date()) - new Date(a);
    if (ms < 0) return "";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}秒`;
    if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
    return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`;
  };
  const STATE_TEXT = { done: "完成", running: "在跑", queued: "排队", retrying: "重试", unknown: "未知", failed: "失败", cancelled: "取消", stopped: "已停" };
  const badgeOf = (s) => `<span class="badge b-${esc(s)}">${STATE_TEXT[s] ?? esc(s)}</span>`;

  let toastTimer;
  function toast(message, bad) {
    const el = $("toast");
    el.textContent = message;
    el.className = "toast show" + (bad ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = "toast"), 3200);
  }

  async function act(payload) {
    try {
      const response = await fetch("/api/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error ?? "操作失败");
      render(body.state);
      toast("已提交");
    } catch (error) {
      toast(error.message, true);
    }
  }

  // 两个独立概念：
  //   collapsed —— 整块列表收起，只剩标题（标题栏按钮控制，带动效）
  //   full      —— 是否显示全部条目（默认只显示前 N 条）
  const LIMITS = { cards: 3, runs: 8, rules: 4, hist: 4 };
  const collapsed = { cards: false, runs: false, rules: false, hist: false };
  const full = { cards: false, runs: false, rules: false, hist: false };
  const PANELS = { cards: "panelCards", runs: "panelRuns", rules: "panelRules", hist: "panelHist" };
  const BUTTONS = { cards: "btnCards", runs: "btnRuns", rules: "btnRules", hist: "btnHist" };
  let lastState = null;

  // ---------- 列表清理：只影响显示，数据一条没删 ----------
  const CLEAR_KEY = "autoloop.cleared.v2";
  function readCleared() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(CLEAR_KEY) || "{}"); } catch {}
    const arr = (value) => (Array.isArray(value) ? value : []);
    return { runs: arr(raw.runs), rules: arr(raw.rules), hist: arr(raw.hist) };
  }
  function writeCleared(value) {
    try { localStorage.setItem(CLEAR_KEY, JSON.stringify(value)); } catch {}
  }
  const ARCHIVE_KEY = "autoloop.archived.v1";
  const readArchived = () => {
    try { return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]"); } catch { return []; }
  };
  const saveArchived = (list) => { try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list)); } catch {} };

  function archiveSession(id) {
    const list = readArchived();
    if (!list.includes(id)) list.push(id);
    saveArchived(list);
    lastSessions = lastSessions.filter((item) => item.id !== id);
    renderSessions();
    toast("已归档，列表里不再显示（文件仍在）");
  }

  function filterCleared(kind, list) {
    const ids = readCleared()[kind] ?? [];
    return (list ?? []).filter((item) => !ids.includes(item.id));
  }
  function clearOne(kind, id) {
    const cleared = readCleared();
    if (!cleared[kind].includes(id)) cleared[kind].push(id);
    writeCleared(cleared);
    renderFromState();
    syncClearButtons();
    toast("已清除这一条，点「恢复」可撤回");
  }
  function clearAll(kind) {
    if (!lastState) return;
    const cleared = readCleared();
    const list = kind === "runs" ? (lastState.runs ?? []) : kind === "rules" ? (lastState.lines ?? []) : (lastState.recentCards ?? []);
    cleared[kind] = Array.from(new Set([...cleared[kind], ...list.map((item) => item.id)]));
    writeCleared(cleared);
    renderFromState();
    syncClearButtons();
    toast(`已清理 ${list.length} 条，数据仍在，点「恢复」可撤回`);
  }
  function undoClear(kind) {
    const cleared = readCleared();
    cleared[kind] = [];
    writeCleared(cleared);
    renderFromState();
    syncClearButtons();
    toast("已恢复显示");
  }
  function syncClearButtons() {
    const cleared = readCleared();
    const set = (id, show) => { const element = $(id); if (element) element.style.display = show ? "" : "none"; };
    set("undoRuns", cleared.runs.length > 0);
    set("undoHist", cleared.hist.length > 0);
    set("undoRules", cleared.rules.length > 0);
  }

  // ---------- 看这一轮到底聊了什么 ----------
  async function openTranscript(id) {
    $("modalTitle").textContent = `第 ${id} 轮 · 完整记录`;
    $("modalHint").textContent = "读取中…";
    $("modalBody").innerHTML = `<div class="loading">加载中…</div>`;
    $("modalMask").classList.add("show");
    try {
      const response = await fetch(`/api/transcript?run=${id}`);
      const body = await response.json();
      if (!body.ok) throw new Error(body.error ?? "读取失败");
      if (!body.found) {
        $("modalHint").textContent = "";
        $("modalBody").innerHTML = `<div class="empty">没找到这一轮的会话文件</div>`;
        return;
      }
      $("modalHint").textContent = `${Math.round(body.size / 1024)} KB · ${body.lines.length} 条`;
      $("modalBody").innerHTML = body.lines.map(transcriptLine).join("") || `<div class="empty">会话文件是空的</div>`;
    } catch (error) {
      $("modalHint").textContent = "";
      $("modalBody").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    }
  }

  function closeModal() {
    $("modalMask").classList.remove("show");
    stopSessionPolling();
    currentPath = "";
  }

  // 内容没变就不动 DOM，否则每次轮询都会打断输入框焦点和选区
  function setHtml(id, html) {
    const element = $(id);
    if (element && element.innerHTML !== html) element.innerHTML = html;
  }

  function togglePanel(kind) {
    collapsed[kind] = !collapsed[kind];
    syncPanelChrome(kind);
  }

  function showAll(kind) {
    full[kind] = true;
    if (collapsed[kind]) collapsed[kind] = false;
    syncPanelChrome(kind);
    renderFromState();
  }

  // 收起状态和按钮文案是纯样式，不用重渲染列表
  function syncPanelChrome(kind) {
    const panel = $(PANELS[kind]);
    if (panel) panel.classList.toggle("collapsed", collapsed[kind]);
    const button = $(BUTTONS[kind]);
    if (button) button.textContent = collapsed[kind] ? "展开 ▾" : "收起 ▴";
  }

  function renderFromState() {
    if (!lastState) return;
    renderCards(lastState.cards ?? [], cardsHintText(lastState));
    renderRuns(lastState.runs ?? []);
    renderRules(lastState.lines ?? []);
    renderHistory(lastState.recentCards ?? []);
  }

  function moreHint(shown, total, kind) {
    if (total <= shown) return "";
    return `<div class="more-hint" onclick="showAll('${kind}')">还有 ${total - shown} 条，显示全部</div>`;
  }

  function cardItem(card) {
    const options = (card.options ?? []).map((option, index) =>
      `<div class="option" onclick='act({"action":"answer","id":${card.id},"choice":${index}})'>
         <span class="idx">${index + 1}</span>${esc(option)}
       </div>`).join("");
    const free = card.kind === "ask" || (card.options ?? []).length
      ? `<div class="free"><input id="free-${card.id}" placeholder="或者直接写你的决定…" onkeydown="if(event.key==='Enter')submitFree(${card.id})" /><button class="small" onclick="submitFree(${card.id})">提交</button></div>`
      : `<div class="free"><button class="small" onclick='act({"action":"resolve","id":${card.id},"reason":"控制台结案"})'>标记已处理</button></div>`;
    return `<div class="card-item">
      <div class="card-head"><span class="card-title">#${card.id} ${esc(card.title)}</span><span class="card-rule">${esc(card.rule || "")}</span></div>
      <div class="card-text">${esc(card.text)}</div>
      <div class="options">${options}</div>
      ${free}
    </div>`;
  }

  function cardsHintText(state) {
    return (state.runs ?? []).some((run) => run.state === "failed" || (run.state === "queued" && (run.attempts ?? 0) > 0))
      ? "有轮次在失败重试：Agent 没跑起来就不会有卡片，去“轮次”里看错误"
      : "";
  }

  function renderCards(cards, hint) {
    $("cardsCount").textContent = cards.length ? `(${cards.length})` : "";
    $("cardsHint").textContent = cards.length ? "点选项即回答" : "";
    syncPanelChrome("cards");
    if (!cards.length) {
      const extra = hint ? `<div style="margin-top:8px;color:var(--warn)">${esc(hint)}</div>` : "";
      setHtml("cardsBody", `<div class="empty">没有待处理的卡片。${extra}</div>`);
      return;
    }
    const shown = cards.slice(0, full.cards ? cards.length : LIMITS.cards);
    setHtml("cardsBody", shown.map(cardItem).join("") + moreHint(shown.length, cards.length, "cards"));
  }

  function submitFree(id) {
    const input = $("free-" + id);
    const text = (input?.value ?? "").trim();
    if (!text) return toast("先写点内容", true);
    act({ action: "answer", id, text });
  }

  function runRow(run) {
    const attempts = run.attempts ?? 0;
    // 有尝试次数还停在 queued，就是失败后在退避重试，不是排队等开工。
    const retrying = run.state === "queued" && attempts > 0;
    const label = retrying ? "重试中" : (STATE_TEXT[run.state] ?? run.state);
    const cls = retrying ? "retrying" : run.state;
    const timing = retrying
      ? `已试 ${attempts} 次 · 下次 ${run.notBefore ? hhmm(run.notBefore) : "—"}`
      : `${stamp(run.createdAt)} · ${span(run.createdAt, run.finishedAt)}`;
    const detail = run.summary || run.error || "（无结论）";
    return `<div class="run" style="cursor:pointer" title="点开看这一轮的完整记录" onclick="openTranscript(${run.id})">
      <span class="id">#${run.id}</span>
      <div>
        <div class="rule">${esc(run.rule)} <span class="badge b-${esc(cls)}">${label}</span></div>
        <div class="summary">${esc(detail)}</div>
      </div>
      <div style="text-align:right"><div class="summary" style="color:var(--faint)">${timing}</div><div style="display:flex;gap:4px;justify-content:flex-end;margin-top:4px"><button class="small ghost" onclick="event.stopPropagation();openTranscript(${run.id})">记录</button><button class="small ghost" onclick="event.stopPropagation();clearOne('runs',${run.id})">✕</button></div></div>
    </div>`;
  }

  function renderRuns(allRuns) {
    const runs = filterCleared("runs", allRuns);
    $("runsCount").textContent = runs.length ? `(${runs.length})` : "";
    syncPanelChrome("runs");
    if (!runs.length) { setHtml("runsBody", `<div class="empty">还没有跑过任何一轮</div>`); return; }
    const shown = runs.slice(0, full.runs ? runs.length : LIMITS.runs);
    setHtml("runsBody", shown.map(runRow).join("") + moreHint(shown.length, runs.length, "runs"));
  }

  function ruleRow(line) {
    const trigger = line.every ? `每 ${line.every}` : (line.types ?? []).join(", ") || line.source || "—";
    const paused = Boolean(line.paused);
    const nameArg = JSON.stringify(line.id);
    return `<div class="rule-row">
      <div class="rule-top">
        <span class="rule-name">${esc(line.name)}</span>
        <span style="font-size:11px;color:${paused ? "var(--warn)" : "var(--faint)"}">${paused ? "已暂停" : esc(line.agent || "")}</span>
      </div>
      <div class="rule-meta">${esc(trigger)} · 下次 ${line.next ? stamp(line.next) : "—"} · 今日 ${line.totals?.doneToday ?? 0} 轮</div>
      <div class="rule-actions">
        <button class="small primary" onclick='act({action:"run",rule:${nameArg}})'>立即运行</button>
        ${paused
          ? `<button class="small ghost" onclick='act({action:"resume",rule:${nameArg}})'>恢复</button>`
          : `<button class="small ghost" onclick='act({action:"pause",rule:${nameArg}})'>暂停</button>`}
        <button class="small ghost" onclick='clearOne("rules", ${JSON.stringify(line.id)})'>✕</button>
      </div>
    </div>`;
  }

  function renderRules(allLines) {
    const lines = filterCleared("rules", allLines);
    $("rulesCount").textContent = lines.length ? `(${lines.length})` : "";
    syncPanelChrome("rules");
    if (!lines.length) { setHtml("rulesBody", `<div class="empty">还没有规则</div>`); return; }
    const shown = lines.slice(0, full.rules ? lines.length : LIMITS.rules);
    setHtml("rulesBody", shown.map(ruleRow).join("") + moreHint(shown.length, lines.length, "rules"));
  }

  function renderOnline(state) {
    const rows = [];
    for (const agent of state.agents ?? []) {
      rows.push(`<div class="online-row"><span class="name"><span class="dot ${agent.online ? "on" : "off"}"></span>${esc(agent.name)}</span><span class="tag">Agent · ${agent.online ? "在线" : "离线"}</span></div>`);
    }
    // /api/agents 里登记、但 hub 不认识的（比如 dsh）也列出来
    for (const extra of agentList) {
      if ((state.agents ?? []).some((agent) => agent.id === extra.id)) continue;
      rows.push(`<div class="online-row"><span class="name"><span class="dot on"></span>${esc(extra.name)}</span><span class="tag">Harness · 已接入</span></div>`);
    }
    for (const channel of state.channels ?? []) {
      rows.push(`<div class="online-row"><span class="name"><span class="dot ${channel.online ? "on" : "off"}"></span>${esc(channel.name)}</span><span class="tag">通道 · ${channel.online ? "在线" : "离线"}</span></div>`);
    }
    for (const source of state.sources ?? []) {
      rows.push(`<div class="online-row"><span class="name"><span class="dot on"></span>${esc(source.name)}</span><span class="tag">来源 · ${source.events ?? 0} 事件</span></div>`);
    }
    setHtml("onlineBody", rows.join("") || `<div class="empty">没有在线的东西</div>`);
  }

  function histItem(card) {
    const closed = card.state === "done" || card.closedAt;
    const verdict = card.result || card.answer || (card.choice !== null && card.choice !== undefined ? `选了：${(card.options ?? [])[card.choice] ?? card.choice}` : "");
    return `<div class="card-item ${closed ? "done" : ""}" style="border-left-color:${closed ? "var(--ok)" : "var(--warn)"};padding:10px 12px;margin-bottom:9px">
      <div class="card-head"><span class="card-title" style="font-size:13px">#${card.id} ${esc(card.title)}</span><span class="card-rule">${stamp(card.closedAt || card.createdAt)} <button class="small ghost" onclick="event.stopPropagation();clearOne('hist',${card.id})">✕</button></span></div>
      ${verdict ? `<div class="card-text" style="margin:5px 0 0;font-size:12px">${esc(verdict)}</div>` : ""}
    </div>`;
  }

  function renderHistory(allCards) {
    const cards = filterCleared("hist", allCards);
    $("histCount").textContent = cards.length ? `(${cards.length})` : "";
    syncPanelChrome("hist");
    if (!cards.length) { setHtml("histBody", `<div class="empty">还没有卡片</div>`); return; }
    const shown = cards.slice(0, full.hist ? cards.length : LIMITS.hist);
    setHtml("histBody", shown.map(histItem).join("") + moreHint(shown.length, cards.length, "hist"));
  }

  function render(state) {
    lastState = state;
    const totals = state.totals ?? {};
    const today = state.spending?.today ?? {};
    $("kRunning").textContent = totals.running ?? 0;
    $("kRunningSub").textContent = `${totals.retrying ?? 0} 重试 · ${totals.unknown ?? 0} 未知`;
    $("kWaiting").textContent = (state.cards ?? []).length;
    $("kWaiting").classList.toggle("hot", (state.cards ?? []).length > 0);
    $("kQueued").textContent = totals.queued ?? 0;
    $("kQueuedSub").textContent = `${state.pauses?.length ?? 0} 条规则暂停`;
    $("kToday").textContent = totals.doneToday ?? 0;
    $("kTodaySub").textContent = `累计 ${totals.done ?? 0} 轮`;

    $("seqText").textContent = `seq ${state.seq ?? "—"}`;
    $("clock").textContent = `更新于 ${hhmm(new Date().toISOString())}`;
    $("dot").className = "dot on";
    $("connText").textContent = "已连接";
    if ($("hubLine")) $("hubLine").textContent = `中台 127.0.0.1:3350 · ${state.timezone ?? ""} · 每 2.5 秒自动刷新`;
    if ($("buildText")) $("buildText").textContent = `界面版本 ${APP_BUILD}`;

    renderCards(state.cards ?? [], cardsHintText(state));
    renderRuns(state.runs ?? []);
    renderRules(state.lines ?? []);
    renderOnline(state);
    renderHistory(state.recentCards ?? []);
    syncClearButtons();
  }


  // 只挑会影响列表显示的部分做指纹，避开耗时、Token 这类每次都变的字段
  function fingerprintOf(state) {
    return JSON.stringify({
      runs: (state.runs ?? []).map((x) => `${x.id}:${x.state}:${x.summary ?? ""}`).join("|"),
      lines: (state.lines ?? []).map((x) => `${x.name}:${x.next}:${x.paused}`).join("|"),
      cards: (state.recentCards ?? []).map((x) => `${x.id}:${x.state}`).join("|"),
      agents: (state.agents ?? []).map((x) => `${x.id}:${x.online}`).join("|"),
      channels: (state.channels ?? []).map((x) => `${x.id}:${x.online}`).join("|"),
    });
  }

  let lastFingerprint = "";

  async function refresh() {
    try {
      if (!agentList.length) { // 在线栏要靠它判断 dsh 在不在
        try { agentList = (await (await fetch("/api/agents")).json()).agents ?? []; } catch {}
      }
      const response = await fetch("/api/state");
      const state = await response.json();
      if (state.error) throw new Error(state.error);
      detectNewCards(state);
      // 内容没变就别整块重建 DOM——否则界面每秒闪一下
      const print = fingerprintOf(state);
      if (print === lastFingerprint) return;
      lastFingerprint = print;
      // 正在输入框里操作时不动页面：任何重建都会打断焦点和选区
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      render(state);
    } catch (error) {
      $("dot").className = "dot off";
      $("connText").textContent = "连不上中台";
      if ($("hubLine")) $("hubLine").textContent = error.message;
    }
  }

  // 新卡片提醒：标题闪烁 + 系统通知 + 页内提示
  let knownCards = null;
  let flashTimer = null;

  function detectNewCards(state) {
    const ids = new Set((state.cards ?? []).map((card) => card.id));
    if (knownCards === null) {
      knownCards = ids;
      return;
    }
    const fresh = (state.cards ?? []).filter((card) => !knownCards.has(card.id));
    knownCards = ids;
    if (!fresh.length) return;

    const first = fresh[0];
    toast(`有 ${fresh.length} 张新卡片等你决定：#${first.id} ${first.title}`);
    flashTitle(fresh.length);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("中台有卡片等你决定", { body: `#${first.id} ${first.title}`, tag: `card-${first.id}` });
    }
  }

  function flashTitle(count) {
    const base = "Agent Autoloop 控制台";
    clearInterval(flashTimer);
    let on = false;
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? `(${count}) 新卡片` : base;
    }, 900);
    setTimeout(() => {
      clearInterval(flashTimer);
      document.title = base;
    }, 12000);
  }

  function enableNotify() {
    if (!("Notification" in window)) return toast("这个浏览器不支持系统通知", true);
    Notification.requestPermission().then((permission) => {
      toast(permission === "granted" ? "已开启，新卡片会弹系统通知" : "没拿到通知权限", permission !== "granted");
    });
  }

  // 离开输入框后补一次渲染，补上暂停期间错过的变化
  document.addEventListener("focusout", (event) => {
    if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA")) {
      setTimeout(refresh, 80);
    }
  });


  // ---------- 会话视图 ----------
  const collapsedGroups = new Set();
  const ALIAS_KEY = "autoloop.alias.v1";
  let aliasMap = {};
  try { aliasMap = JSON.parse(localStorage.getItem(ALIAS_KEY) || "{}"); } catch {}
  const saveAlias = () => { try { localStorage.setItem(ALIAS_KEY, JSON.stringify(aliasMap)); } catch {} };

  let lastSessions = [];
  let agentList = [];
  let projects = [];
  let editingId = "";
  let currentSession = null;
  let currentPath = "";
  let currentRule = "";
  let currentCwd = "";
  let currentTab = "chat";
  let currentKeyword = "";
  let sessionTimer = null;
  let importId = "";
  const attach = { new: [], continue: [] };

  async function loadProjects() {
    try {
      const response = await fetch("/api/projects");
      const body = await response.json();
      if (body.ok) projects = body.projects ?? [];
    } catch {}
    const list = $("projectList");
    if (list) list.innerHTML = projects.map((item) => `<option value="${esc(item.path)}">${esc(item.name)}</option>`).join("");
    const select = $("impTarget");
    if (select) select.innerHTML = projects.map((item) => `<option value="${esc(item.path)}">${esc(item.name)} · ${esc(item.path)}</option>`).join("");
  }

  async function loadSessions() {
    const keyword = ($("sessionSearch")?.value ?? "").trim();
    currentKeyword = keyword;
    setHtml("sessionsBody", `<div class="loading">加载中…</div>`);
    try {
      if (!projects.length) loadProjects();
      const [sessionRes, agentRes] = await Promise.all([
        fetch(`/api/sessions${keyword ? `?q=${encodeURIComponent(keyword)}` : ""}`),
        fetch(`/api/agents`),
      ]);
      const sessionBody = await sessionRes.json();
      const agentBody = await agentRes.json();
      if (!sessionBody.ok) throw new Error(sessionBody.error ?? "读取失败");
      const archived = readArchived();
      lastSessions = (sessionBody.sessions ?? []).filter((item) => !archived.includes(item.id));
      dshOnline = lastSessions.some((item) => item.dsh);
      agentList = agentBody.agents ?? [];
      renderSessions();
    } catch (error) {
      setHtml("sessionsBody", `<div class="empty">${esc(error.message)}</div>`);
    }
  }

  function renderSessions() {
    $("sessionsCount").textContent = lastSessions.length ? `(${lastSessions.length})` : "";
    if ($("navSessCount")) $("navSessCount").textContent = lastSessions.length ? String(lastSessions.length) : "";
    const groups = new Map();
    for (const agent of agentList) groups.set(agent.name, { id: agent.id, items: [] });
    for (const item of lastSessions) {
      if (!groups.has(item.agent)) groups.set(item.agent, { id: "", items: [] });
      groups.get(item.agent).items.push(item);
    }
    if (!groups.size) { setHtml("sessionsBody", `<div class="empty">中台没有在线 Agent</div>`); return; }
    // 顺序：DeepSeek Harness 优先，其次登记的 Agent，最后「无会话号的运行」
    const order = (name) => (name === "DeepSeek Harness" ? 0 : name === "无会话号的运行" ? 2 : 1);
    const ordered = [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]));

    const html = ordered.map(([agent, group]) => {
      const folded = collapsedGroups.has(agent);
      const items = group.items;
      const body = items.length
        ? items.map(sessionRow).join("")
        : `<div class="empty" style="padding:14px 0">暂无会话</div>`;
      const meta = agentList.find((item) => item.name === agent);
      const badge = meta ? (meta.supportsSession
        ? `<span class="sbadge ok">可续接</span>`
        : `<span class="sbadge">仅单轮</span>`) : "";
      const addButton = agent === "DeepSeek Harness"
        ? `<button class="small primary" onclick="event.stopPropagation();openNew('dsh','DeepSeek Harness')">新建会话</button>`
        : group.id
          ? `<button class="small primary" onclick="event.stopPropagation();openNew('${esc(group.id)}','${esc(agent)}')">新增会话</button>`
          : "";
      return `<div class="sgroup${folded ? " folded" : ""}">
        <div class="sgroup-head" onclick="toggleGroup('${esc(agent)}', this)">
          <span class="caret">▾</span>
          <span class="sgroup-name">${esc(agent)}</span>
          ${badge}
          <span class="sgroup-count">${items.length} 个会话</span>
          ${addButton}
        </div>
        ${folded ? "" : `<div class="sgroup-body">${body}</div>`}
      </div>`;
    }).join("");
    setHtml("sessionsBody", html);
  }

  function sessionRow(item) {
    const title = aliasMap[item.id] || item.label;
    const editing = editingId === item.id;
    const titleHtml = editing
      ? `<input class="rename-input" id="rn-${item.id}" value="${esc(title)}"
           onkeydown="if(event.key==='Enter')saveRename('${item.id}');if(event.key==='Escape'){editingId='';renderSessions()}"
           onblur="saveRename('${item.id}')" />`
      : `<div class="session-title" onclick='openSession(${JSON.stringify(item.path)}, ${JSON.stringify(item.rule)})'>${esc(title)}</div>`;
    return `<div class="session-row">
      <div>
        ${titleHtml}
        <div class="session-meta">${esc(item.projectLabel)} · ${esc(item.id.slice(0, 8))}…</div>
      </div>
      <div class="session-side">${stamp(new Date(item.mtime).toISOString())}<br/>${item.dsh ? item.size + " 条事件" : Math.round(item.size / 1024) + " KB"}</div>
      <div class="session-actions">
        <button class="small ghost" title="重命名" onclick="event.stopPropagation();startRename('${item.id}')">✎</button>
        <button class="small ghost" title="导入到项目" onclick="event.stopPropagation();openImport('${item.id}')">⇥</button>
        <button class="small ghost" title="归档（不再显示）" onclick="event.stopPropagation();archiveSession('${item.id}')">🗑</button>
      </div>
    </div>`;
  }

  function startRename(id) {
    editingId = id;
    renderSessions();
    setTimeout(() => {
      const input = $("rn-" + id);
      if (input) { input.focus(); input.select(); }
    }, 30);
  }

  function saveRename(id) {
    const input = $("rn-" + id);
    if (!input || editingId !== id) return;
    const value = input.value.trim();
    if (value) aliasMap[id] = value; else delete aliasMap[id];
    saveAlias();
    editingId = "";
    renderSessions();
  }

  function toggleGroup(agent, element) {
    if (collapsedGroups.has(agent)) collapsedGroups.delete(agent); else collapsedGroups.add(agent);
    const group = element?.closest ? element.closest(".sgroup") : null;
    if (group) { group.classList.toggle("folded", collapsedGroups.has(agent)); return; }
    renderSessions();
  }

  // ---------- 导入到项目 ----------
  function openImport(id) {
    importId = id;
    const item = lastSessions.find((entry) => entry.id === id);
    if (!item) return;
    if (!projects.length) loadProjects();
    $("impMask").classList.add("show");
  }

  function closeImport() {
    $("impMask").classList.remove("show");
    importId = "";
  }

  async function doImport() {
    const item = lastSessions.find((entry) => entry.id === importId);
    if (!item) return toast("找不到这条会话", true);
    const targetCwd = $("impTarget").value;
    if (!targetCwd) return toast("先选目标项目", true);
    try {
      const response = await fetch("/api/session/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionPath: item.path, targetCwd, title: aliasMap[item.id] || item.label, removeSource: $("impRemove").checked }),
      });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error ?? "导入失败");
      closeImport();
      toast("已导入，在目标项目打开 CodeBuddy 就能看到");
      loadSessions();
    } catch (error) {
      toast(error.message, true);
    }
  }

  // ---------- 新建会话 ----------
  async function openNew(agentId, agentName) {
    closeModal();
    closeImport();
    if (!projects.length) await loadProjects();
    const meta = agentList.find((item) => item.id === agentId);
    if (meta && !meta.supportsSession) {
      toast("这个 Agent 不回传会话号：跑完会落到「无会话号的运行」里，不能续派。建议用带 ACP 的那个", true);
    }
    $("newTitle").textContent = `新增会话 · ${agentName}`;
    $("newAgent").value = agentName;
    $("newAgent").dataset.id = agentId;
    $("newName").value = "";
    // 默认落在最近用过的项目上，省得手工录路径
    $("newCwd").value = projects[0]?.path ?? "C:\\Users\\13694\\WorkBuddy\\";
    $("newModel").value = "";
    $("newPrompt").value = "";
    $("newHint").textContent = "";
    attach.new = [];
    renderChips("new");
    $("newMask").classList.add("show");
  }

  function closeNew() {
    $("newMask").classList.remove("show");
  }

  // ---------- 附件芯片 ----------
  function renderChips(kind) {
    const box = $(kind === "new" ? "newChips" : "continueChips");
    if (!box) return;
    box.innerHTML = attach[kind].map((file, index) =>
      `<span class="chip">${esc(file.name)}<button onclick="removeChip('${kind}',${index})">✕</button></span>`).join("");
  }

  function removeChip(kind, index) {
    attach[kind].splice(index, 1);
    renderChips(kind);
  }

  function chipsText(kind) {
    if (!attach[kind].length) return "";
    return `\n\n参考文件：\n${attach[kind].map((file) => `- ${file.path}`).join("\n")}`;
  }

  async function uploadFiles(files, dir) {
    if (!dir) throw new Error("先填工作目录，文件才知道放哪");
    for (const file of files) {
      const response = await fetch(`/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error ?? "上传失败");
      attach[currentDropKind].push({ name: file.name, path: body.path });
    }
    renderChips(currentDropKind);
  }

  let currentDropKind = "new";

  function wireDrop(elementId, kind, dirGetter) {
    const zone = $(elementId);
    if (!zone) return;
    ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => {
      event.preventDefault();
      zone.classList.add("over");
      currentDropKind = kind;
    }));
    ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, () => zone.classList.remove("over")));
    zone.addEventListener("drop", async (event) => {
      event.preventDefault();
      zone.classList.remove("over");
      currentDropKind = kind;
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      try {
        await uploadFiles(files, dirGetter());
        toast(`已添加 ${files.length} 个文件`);
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  async function startNewSession() {
    const name = $("newName").value.trim();
    const agentId = $("newAgent").dataset.id || "";
    const agentLabel = $("newAgent").value.trim();
    // dsh 不是中台的 Agent，走它自己的写入通道
    if ((agentId === "dsh") || agentLabel === "DeepSeek Harness") {
      const res = await fetch("/api/dsh/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: $("newCwd").value.trim(), name: $("newName").value.trim() || "中台会话", prompt: $("newPrompt").value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return toast(data.error ?? `创建失败：${res.status}`, true);
      closeNew();
      showView("sessions");
      toast("已在 DeepSeek Harness 里建好会话，内容由同步持续补");
      return;
    }
    const agent = agentId || agentLabel;
    const cwd = $("newCwd").value.trim();
    const model = $("newModel").value.trim();
    const prompt = $("newPrompt").value.trim();
    if (!name) return toast("先填会话名", true);
    if (!cwd) return toast("先填工作目录", true);
    if (!prompt) return toast("先写需求", true);
    $("newHint").textContent = "提交中…";
    try {
      const response = await fetch("/api/session/new", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, agent, cwd, model, prompt: prompt + chipsText("new") }),
      });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error ?? "提交失败");
      closeNew();
      logOk(`新建会话「${name}」→ ${agentId || agentLabel}`);
      loadSessions();
      toast("已派活");
      setTimeout(loadSessions, 1500);
    } catch (error) {
      $("newHint").textContent = "";
      toast(error.message, true);
    }
  }

  // ---------- @ 引用文件 ----------
  function wireSuggest(textareaId, suggestId, kind, cwdGetter) {
    const textarea = $(textareaId);
    const box = $(suggestId);
    if (!textarea || !box) return;
    let pending = 0;
    textarea.addEventListener("input", async () => {
      const caret = textarea.selectionStart ?? textarea.value.length;
      const before = textarea.value.slice(0, caret);
      const match = before.match(/@([^\s@]*)$/);
      if (!match) { box.innerHTML = ""; return; }
      const word = match[1];
      const sequence = ++pending;
      try {
        const response = await fetch(`/api/files?cwd=${encodeURIComponent(cwdGetter() || "")}&q=${encodeURIComponent(word)}`);
        const body = await response.json();
        if (sequence !== pending || !body.ok) return;
        const files = (body.files ?? []).slice(0, 30);
        box.innerHTML = files.length
          ? `<div class="suggest-list">${files.map((file) => `<div class="suggest-item" onclick="insertRef('${textareaId}','${suggestId}','${file.replace(/\\/g, "\\\\").replace(/'/g, "")}')">${esc(file)}</div>`).join("")}</div>`
          : `<div class="suggest-list"><div class="suggest-item" style="color:#8fa1b8">没有匹配的文件</div></div>`;
      } catch {}
    });
    textarea.addEventListener("blur", () => setTimeout(() => { box.innerHTML = ""; }, 180));
  }

  function insertRef(textareaId, suggestId, file) {
    const textarea = $(textareaId);
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, caret).replace(/@[^\s@]*$/, `@${file} `);
    textarea.value = before + textarea.value.slice(caret);
    textarea.focus();
    $(suggestId).innerHTML = "";
  }

  // ---------- 会话详情 ----------
  async function openSession(file, rule) {
    closeNew();
    closeImport();
    currentPath = file;
    currentRule = rule ?? "";
    currentCwd = lastSessions.find((item) => item.path === file)?.cwd ?? "";
    $("modalTitle").textContent = "会话";
    $("modalHint").textContent = "读取中…";
    $("modalTabs").style.display = "none";
    $("modalFoot").style.display = currentRule ? "" : "none";
    $("modalBody").innerHTML = `<div class="loading">加载中…</div>`;
    $("modalMask").classList.add("show");
    attach.continue = [];
    renderChips("continue");
    try {
      const response = await fetch(`/api/session?path=${encodeURIComponent(file)}`);
      const body = await response.json();
      if (!body.ok) throw new Error(body.error ?? "读取失败");
      currentSession = body;
      currentTab = "chat";
      $("modalHint").textContent = `${Math.round(body.size / 1024)} KB`;
      renderSessionTabs();
      renderSessionTab();
      startSessionPolling();
    } catch (error) {
      $("modalHint").textContent = "";
      $("modalBody").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    }
  }

  function stopSessionPolling() {
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;
  }

  function startSessionPolling() {
    stopSessionPolling();
    if (!currentSession) return;
    let offset = currentSession.size ?? 0;
    sessionTimer = setInterval(async () => {
      if (!currentPath) return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      try {
        const response = await fetch(`/api/session/more?path=${encodeURIComponent(currentPath)}&since=${offset}`);
        const body = await response.json();
        if (!body.ok || !body.grew) return;
        offset = body.offset;
        currentSession.lines = [...(currentSession.lines ?? []), ...(body.lines ?? [])];
        currentSession.artifacts = [...(currentSession.artifacts ?? []), ...(body.artifacts ?? [])];
        if (currentTab === "chat") renderSessionTab();
        renderSessionTabs();
      } catch {}
    }, 2000);
  }

  function copyResume() {
    const id = (currentPath || "").split(/[\\/]/).pop().replace(/\.jsonl$/, "");
    const cwd = currentCwd || $("newCwd").value.trim();
    const cmd = `cd /d "${cwd}"\ncodebuddy -r ${id}`;
    const done = () => toast("已复制：在终端里粘贴就能接着这个会话聊");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(cmd).then(done).catch(() => toast(cmd, true));
    else toast(cmd, true);
  }

  async function continueSession() {
    const prompt = $("continuePrompt").value.trim();
    if (!currentRule) return toast("这个会话没有关联规则，无法续派", true);
    if (!prompt) return toast("先写需求", true);
    try {
      const response = await fetch("/api/session/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: currentRule, prompt: prompt + chipsText("continue") }),
      });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error ?? "提交失败");
      $("continuePrompt").value = "";
      attach.continue = [];
      renderChips("continue");
      toast("已在这个会话里继续派活");
    } catch (error) {
      toast(error.message, true);
    }
  }

  function renderSessionTabs() {
    const counts = {
      chat: (currentSession?.lines ?? []).length,
      artifacts: (currentSession?.artifacts ?? []).length,
      thoughts: (currentSession?.thoughts ?? []).length,
    };
    $("modalTabs").style.display = "";
    $("modalTabs").innerHTML = [["chat", "对话"], ["artifacts", "产物"], ["thoughts", "思维链"]]
      .map(([key, text]) => `<button class="small tab ${currentTab === key ? "on" : ""}" onclick="switchSessionTab('${key}')">${text} ${counts[key]}</button>`)
      .join("");
  }

  function switchSessionTab(tab) {
    currentTab = tab;
    renderSessionTabs();
    renderSessionTab();
  }

  function highlight(text, word) {
    const safe = esc(text);
    if (!word) return safe;
    const pattern = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return safe.replace(pattern, "<mark>$1</mark>");
  }

  function eventCard(line) {
    const time = line.at ? hhmm(new Date(line.at).toISOString()) : "";
    const word = currentKeyword;
    if (line.kind === "user") {
      // 派活的正文常常是整段提示词，太长就先折起来
      const long = (line.text ?? "").length > 500;
      const head = long
        ? `<div class="ev-head" onclick="this.parentElement.classList.toggle('folded')">派活 · 点击展开全文<span class="ev-time">${time}</span></div>`
        : `<div class="ev-head">派活<span class="ev-time">${time}</span></div>`;
      return `<div class="ev ev-user${long ? " folded" : ""}">${head}<div class="ev-body">${highlight(line.text, word)}</div></div>`;
    }
    if (line.kind === "assistant") {
      return `<div class="ev ev-think"><div class="ev-head">思考</div><div class="ev-body">${highlight(line.text, word)}</div><span class="ev-time">${time}</span></div>`;
    }
    if (line.kind === "call") {
      return `<div class="ev ev-tool folded"><div class="ev-head" onclick="this.parentElement.classList.toggle('folded')">🔧 ${esc(line.name)}<span class="ev-time">${time}</span></div><div class="ev-body"><pre>${esc(line.text)}</pre></div></div>`;
    }
    const bad = line.status && line.status !== "success" ? " ev-bad" : "";
    return `<div class="ev ev-result folded${bad}"><div class="ev-head" onclick="this.parentElement.classList.toggle('folded')">↳ ${esc(line.name)} 结果<span class="ev-time">${time}</span></div><div class="ev-body"><pre>${esc(line.text)}</pre></div></div>`;
  }

  // 老名字保留，轮次那边的「记录」也在用
  const transcriptLine = eventCard;

  function renderSessionTab() {
    if (!currentSession) return;
    if (currentTab === "artifacts") {
      const list = currentSession.artifacts ?? [];
      setHtml("modalBody", list.length
        ? `<div class="artifacts">${list.map((item) => `<div class="artifact"><span class="aname">${esc(item.path)}</span><span class="atool">${esc(item.tool)}</span></div>`).join("")}</div>`
        : `<div class="empty">这次会话没有写文件的动作</div>`);
      return;
    }
    if (currentTab === "thoughts") {
      const list = currentSession.thoughts ?? [];
      setHtml("modalBody", list.length
        ? list.map((text, index) => `<div class="thought"><span class="tidx">${index + 1}</span><div>${highlight(text, currentKeyword)}</div></div>`).join("")
        : `<div class="empty">没有单独的思考文本</div>`);
      return;
    }
    setHtml("modalBody", (currentSession.lines ?? []).map(eventCard).join("") || `<div class="empty">会话是空的</div>`);
    const box = $("modalBody");
    if (box) box.scrollTop = box.scrollHeight;
  }

  let sessionsTimer = null;
  function keepSessionsFresh() {
    // 停在会话页时每 5 秒拉一次，新建/续派完不用手动点
    if (sessionsTimer) return;
    sessionsTimer = setInterval(() => {
      if ($("viewSessions")?.style.display !== "none") loadSessions();
    }, 5000);
  }

  function showView(name) {
    const map = { board: ["viewBoard", "navBoard"], workbench: ["viewWorkbench", "navWork"], sessions: ["viewSessions", "navSessions"] };
    for (const [key, [viewId, navId]] of Object.entries(map)) {
      const view = $(viewId);
      if (view) view.style.display = key === name ? "" : "none";
      const nav = $(navId);
      if (nav) nav.classList.toggle("on", key === name);
    }
    if (name === "workbench") {
      const frame = $("wbFrame");
      // 第一次切进来才真正加载，避免一打开页面就拉远端
      if (frame && frame.src === "about:blank") frame.src = frame.dataset.src;
    }
    if (name === "sessions") { loadSessions(); keepSessionsFresh(); }
  }

  wireDrop("newDrop", "new", () => $("newCwd").value.trim());
  wireDrop("newPrompt", "new", () => $("newCwd").value.trim());
  const cwdForContinue = () => currentCwd || $("newCwd").value.trim();
  wireDrop("continueDrop", "continue", cwdForContinue);
  wireDrop("continuePrompt", "continue", cwdForContinue);
  wireSuggest("newPrompt", "newSuggest", "new", () => $("newCwd").value.trim());
  wireSuggest("continuePrompt", "continueSuggest", "continue", cwdForContinue);
  const initialView = new URLSearchParams(location.search).get("view");
  if (initialView) showView(initialView);
  refresh();
  setInterval(refresh, 2500);
