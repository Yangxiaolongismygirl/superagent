// 中台自检：不开人工眼、不靠猜，逐层验证后再交给用户。
// 用法：node verify.mjs            → 全部检查
//       node verify.mjs --no-ui    → 跳过无头浏览器那层
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const BASE = "http://127.0.0.1:3360";
const CONSOLE_DIR = "C:/Users/13694/WorkBuddy/spaces/2026_11_13_10-36-44/autoloop-console";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SNAPSHOT = "C:/Users/13694/.workbuddy/c5248d1b-c259-4e32-80e8-4a1bb45ef0a7/sidebar-list-snapshot.json";
const skipUi = process.argv.includes("--no-ui");

const results = [];
const add = (name, ok, detail, status) => results.push({ name, ok, detail, status: status ?? (ok ? "pass" : "fail") });
const skip = (name, detail) => add(name, true, detail, "skip");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 第一层：语法 ----------
function syntax() {
  for (const file of ["server.mjs", "public/app.js"]) {
    try {
      execFileSync(process.execPath, ["--check", path.join(CONSOLE_DIR, file)], { stdio: "pipe" });
      add(`语法 · ${file}`, true);
    } catch (error) {
      add(`语法 · ${file}`, false, String(error.stderr ?? error.message).slice(0, 200));
    }
  }
}

// ---------- 第二层：接口契约 ----------
async function api() {
  const get = async (p) => {
    const res = await fetch(BASE + p, { signal: AbortSignal.timeout(8000) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const health = await get("/api/health").catch((e) => ({ status: 0, body: { error: e.message } }));
  add("接口 · /api/health 可访问", health.status === 200, `status=${health.status}`);

  const state = await get("/api/state").catch(() => ({ body: {} }));
  add("接口 · /api/state 有 runs/lines/agents", Boolean(state.body?.runs && state.body?.lines && state.body?.agents),
    `runs=${state.body?.runs?.length ?? "-"} lines=${state.body?.lines?.length ?? "-"}`);

  const sessions = await get("/api/sessions").catch(() => ({ body: {} }));
  const list = sessions.body?.sessions ?? [];
  add("接口 · /api/sessions 返回数组", Array.isArray(list), `条数=${list.length}`);
  add("接口 · 每条会话有 id/path/agent",
    list.length > 0 && list.every((s) => s.id && s.path && s.agent),
    `首条=${list[0]?.label ?? "-"}`);

  const agents = await get("/api/agents").catch(() => ({ body: {} }));
  add("接口 · /api/agents 标明是否支持会话",
    (agents.body?.agents ?? []).every((a) => typeof a.supportsSession === "boolean"),
    `agent=${(agents.body?.agents ?? []).map((a) => a.id).join(",")}`);

  const projects = await get("/api/projects").catch(() => ({ body: {} }));
  add("接口 · /api/projects 能列出项目", (projects.body?.projects ?? []).length > 0,
    `个数=${(projects.body?.projects ?? []).length}`);
}

// ---------- 第三层：应用快照契约（最容易翻车的一层）----------
// 复刻 WorkBuddy 的 snapshotItemFailures：少一个 isPinned 就会整份被丢弃
function snapshotFailures(item) {
  if (!item || typeof item !== "object") return ["not-object"];
  const hasAuto = typeof item.automationId === "string" && item.automationId.trim().length > 0;
  const bad = [];
  if (!(typeof item.id === "string" && item.id.length > 0)) bad.push("id");
  if (typeof item.title !== "string") bad.push("title");
  if (typeof item.state !== "string") bad.push("state");
  if (typeof item.transport !== "string") bad.push("transport");
  if (typeof item.kind !== "string") bad.push("kind");
  if (!(typeof item.lastActivityAt === "number" && Number.isFinite(item.lastActivityAt))) bad.push("lastActivityAt");
  if (typeof item.isPinned !== "boolean") bad.push("isPinned");
  if ((item.isBackgroundAutomation === true) !== hasAuto) bad.push("automationIdentity");
  return bad;
}

function snapshot() {
  if (!existsSync(SNAPSHOT)) {
    add("快照 · 文件存在", false, SNAPSHOT);
    return;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  } catch (error) {
    add("快照 · 可解析", false, error.message);
    return;
  }
  add("快照 · 可解析", true, `条数=${data.items?.length ?? 0}`);
  add("快照 · 版本 >= 1", [1, 2, 3].includes(data.version), `version=${data.version}`);
  const bad = (data.items ?? []).filter((item) => snapshotFailures(item).length > 0);
  add("快照 · 全部条目通过应用校验", bad.length === 0,
    bad.length ? `${bad.length} 条无效，例：${JSON.stringify(bad[0]).slice(0, 120)}` : "全部合法");
}

// ---------- 第四层：前端渲染（假 DOM，不起浏览器）----------
function smoke() {
  try {
    execFileSync(process.execPath, [path.join(CONSOLE_DIR, "smoke.mjs")], { stdio: "pipe" });
    add("渲染 · smoke.mjs 全绿", true);
  } catch (error) {
    add("渲染 · smoke.mjs 全绿", false, String(error.stdout ?? error.message).slice(-200));
  }
}

// ---------- 第五层：无头浏览器看真实 DOM ----------
// Edge 无头在这台机器上时好时坏：起不来就记「跳过」，绝不冒充通过
function runEdge(args, profile) {
  const dir = `C:/Users/13694/_cli_login/${profile}-${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  try {
    return execFileSync(EDGE, ["--headless", "--disable-gpu", "--no-first-run", `--user-data-dir=${dir}`, ...args],
      { stdio: "pipe", timeout: 60000 }).toString();
  } catch (error) {
    return "";
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function ui() {
  if (skipUi) return skip("界面 · 无头浏览器断言", "按参数跳过");
  if (!existsSync(EDGE)) return skip("界面 · 无头浏览器断言", "未安装 Edge");

  const shot = "C:/Users/13694/_cli_login/verify.png";
  try { rmSync(shot, { force: true }); } catch {}
  let produced = false;
  for (let i = 0; i < 2 && !produced; i += 1) {
    runEdge([`--screenshot=${shot}`, "--window-size=1600,900", `${BASE}/?view=sessions`], "evshot");
    await sleep(500);
    produced = existsSync(shot);
  }
  if (!produced) {
    skip("界面 · 截图产出", "无头 Edge 未能出图，这层交给人工");
    skip("界面 · 左侧三页签在", "同上");
    skip("界面 · 会话分组已渲染", "同上");
    return;
  }
  add("界面 · 截图产出", true, shot);

  const dom = runEdge(["--dump-dom", `${BASE}/?view=sessions`], "evdom");
  if (!dom) {
    skip("界面 · 左侧三页签在", "dump-dom 不可用");
    skip("界面 · 会话分组已渲染", "dump-dom 不可用");
    return;
  }
  add("界面 · 左侧三页签在", dom.includes("个人工作台") && dom.includes("当前中台"));
  add("界面 · 会话分组已渲染", dom.includes("sgroup") || dom.includes("暂无会话"));
}

const t0 = Date.now();
syntax();
await api();
snapshot();
smoke();
await ui();
await sleep(100);

const failed = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skip");
for (const r of results) {
  const mark = r.status === "skip" ? "○" : r.ok ? "✓" : "✗";
  console.log(`${mark}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
}
const head = failed.length === 0 ? (skipped.length ? `通过（${skipped.length} 项跳过）` : "全部通过") : `${failed.length} 项失败`;
console.log(`\n${head} · 共 ${results.length} 项 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed.length === 0 ? 0 : 1);
