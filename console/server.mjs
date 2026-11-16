// agent-autoloop 本地可视化控制台：读中台状态、回答问题卡片、触发规则。
// 只监听 127.0.0.1，owner 密钥留在服务端，不下发到浏览器。
import { createServer } from "node:http";
import { readFile, readdir, stat, open, writeFile, mkdir, copyFile, unlink, rename } from "node:fs/promises";
import { createHash, randomUUID as uuidv4 } from "node:crypto";
import { spawn } from "node:child_process";
import { listDshSessions, readDshAsCli, writeDshSession } from "./dsh-sync.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

const HOME = "C:\\Users\\13694\\.agent-autoloop";
const CLI_PROJECTS = "C:\\Users\\13694\\.codebuddy\\projects";
const RULES_FILE = path.join(HOME, "rules.json");
const CLAIMS_FILE = path.join(HOME, "session-claims.json");
const config = JSON.parse(readFileSync(path.join(HOME, "config.json"), "utf8"));
const HUB = config.url ?? "http://127.0.0.1:3350";
const OWNER = config.owner;
const PORT = Number(process.env.PORT ?? 3360);
const PUBLIC = path.join(import.meta.dirname, "public");

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

async function hub(pathname, init = {}) {
  const response = await fetch(`${HUB}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(body.error ?? `中台返回 ${response.status}`);
  return body;
}

// 前端只认识动作名，怎么打到中台由这里决定。
async function act({ action, id, rule, choice, text, reason }) {
  const post = (pathname, payload) => hub(pathname, { method: "POST", body: JSON.stringify(payload ?? {}) });
  switch (action) {
    case "answer":
      return text ? post(`/v1/cards/${id}/answer`, { text }) : post(`/v1/cards/${id}/answer`, { choice });
    case "resolve":
      return post(`/v1/cards/${id}/resolve`, { reason });
    case "cancel":
      return post(`/v1/runs/${id}/cancel`, {});
    case "run":
      return post(`/v1/rules/${encodeURIComponent(rule)}/run`, {});
    case "pause":
      return post(`/v1/rules/${encodeURIComponent(rule)}/pause`, { reason: reason || "控制台暂停" });
    case "resume":
      return post(`/v1/rules/${encodeURIComponent(rule)}/resume`, {});
    default:
      throw new Error(`不认识的动作：${action}`);
  }
}

const json = (response, code, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(payload);
};


// 一条规则 = 一个会话。规则带唯一的 event type，后续派活都发这个 type 的事件，
// 需求正文放在事件的 detail 里，Agent 从 context.json 读。
function slugOf(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
}

async function readRules() {
  return JSON.parse(await readFile(RULES_FILE, "utf8"));
}

async function emitEvent(type, summary, detail) {
  const sourceKey = config.source?.key;
  if (!sourceKey) throw new Error("config.json 里没有 source.key，无法发事件");
  const response = await fetch(`${HUB}/v1/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sourceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: `${type}:${Date.now()}`, type, subject: "", summary: String(summary ?? "").slice(0, 200), detail: String(detail ?? "").slice(0, 4000) }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `发事件失败 ${response.status}`);
  return body;
}


// 等中台把规则装载进来（它每 tick 重读 rules.json）
async function waitForRule(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await hub("/v1/state");
      if ((state.lines ?? []).some((line) => line.name === name)) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function createSession(input) {
  const name = String(input.name ?? "").trim() || "未命名会话";
  const agent = String(input.agent ?? "").trim();
  const cwd = String(input.cwd ?? "").trim();
  const model = String(input.model ?? "").trim();
  const prompt = String(input.prompt ?? "").trim();
  if (!agent) throw new Error("没选 Agent");
  if (!cwd) throw new Error("没填工作目录");
  if (!prompt) throw new Error("需求不能为空");

  // to 必须是中台登记的 Agent id，不是显示名——这里挡一道，免得写下无效规则
  const state = await hub("/v1/state");
  const agents = state.agents ?? [];
  // 兼容两种写法：传 id 或传显示名都认（老前端只会传显示名）
  const known = agents.find((item) => item.id === agent) ?? agents.find((item) => item.name === agent);
  if (!known) throw new Error(`「${agent}」不是中台登记的 Agent（可用：${agents.map((item) => item.id).join("、")}）`);
  const agentId = known.id;
  // 目录统一成反斜杠单分隔，并确认存在
  const normalized = cwd.replace(/[\\/]+/g, "\\").replace(/\\+$/, "");
  try {
    const info = await stat(normalized);
    if (!info.isDirectory()) throw new Error("不是目录");
  } catch {
    throw new Error(`目录不存在：${normalized}`);
  }

  const rules = await readRules();
  const type = `session.${slugOf(name)}.${Date.now().toString(36)}`;
  const rule = {
    name: `会话·${name}`,
    when: { source: "local", types: [type] },
    to: agentId,
    cwd: normalized,
    resume: true,
    // 中台只把 rule.prompt 拼进对话，事件的 detail 不进正文，
    // 所以用户这句话必须写进 prompt 里，否则对话里只有固定提示词。
    prompt: `用户这次的需求：${prompt}\n\n直接动手做这件事。以上是用户原话，不是示例；没有额外说明就不要反问、不要编造。`,
  };
  if (model) rule.model = model;
  rules.rules = [...(rules.rules ?? []).filter((item) => item.name !== rule.name), rule];

  // 原子写：先写临时文件再改名，避免中台每 tick 读到半截 JSON 报「rules.json 写错了」
  const tmp = `${RULES_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rules, null, 2), "utf8");
  await rename(tmp, RULES_FILE);

  // 写完必须确认中台真的重载了这条规则，否则事件会落到旧规则里
  const confirmed = await waitForRule(rule.name, 8000);
  if (!confirmed) throw new Error(`规则没被中台接管（${rule.name}），检查 rules.json 是否被其他程序改写`);
  // summary 用用户原话：中台把 summary 拼进对话，detail 只落到 context.json，
  // 只写「新会话：xxx」的话，用户在对话里根本看不到自己写的那句。
  await emitEvent(type, prompt, prompt);
  return { rule: rule.name, type };
}

async function continueSession(input) {
  const ruleName = String(input.rule ?? "").trim();
  const prompt = String(input.prompt ?? "").trim();
  if (!ruleName) throw new Error("没指定会话");
  if (!prompt) throw new Error("需求不能为空");
  const rules = await readRules();
  const rule = (rules.rules ?? []).find((item) => item.name === ruleName);
  if (!rule) throw new Error("找不到这个会话对应的规则");
  const type = rule.when?.types?.[0];
  if (!type) throw new Error("这条会话没有事件类型");
  await emitEvent(type, `继续：${ruleName}`, prompt);
  return { rule: ruleName, type };
}


// 工作目录 -> CLI 的分桶目录名：C://Users//x → c-Users-x
function slugOfCwd(cwd) {
  return cwd.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `${drive.toLowerCase()}-`).replace(/[\\/]/g, "-");
}

async function listProjects() {
  const root = "C:////Users////13694////WorkBuddy////spaces";
  const items = [];
  let dirs = [];
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(root, dir.name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    items.push({ name: dir.name, path: full, mtime: info.mtimeMs });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

// 给 @ 引用用：列 cwd 下的文件，跳过重目录，最多 300 条
async function listFiles(cwd, keyword) {
  const skip = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".cache"]);
  const out = [];
  const word = (keyword ?? "").toLowerCase();
  async function walk(dir, depth) {
    if (out.length >= 300 || depth > 3) return;
    let items = [];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= 300) return;
      if (item.name.startsWith(".") || skip.has(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        const rel = path.relative(cwd, full);
        if (word && !rel.toLowerCase().includes(word)) continue;
        out.push(rel);
      }
    }
  }
  await walk(cwd, 0);
  return out;
}


// CodeBuddy 桌面端的「工作空间」列表读的是这个 sqlite，不是 projects 目录，
// 所以导入会话时还得往索引里补一条，否则应用里看不到。
const CB_DBS = [
  "C:////Users////13694////AppData////Roaming////CodeBuddy////codebuddy-sessions.vscdb",
  "C:////Users////13694////AppData////Roaming////WorkBuddy////codebuddy-sessions.vscdb",
];


// 桌面端各自有独立的会话目录：CLI 在 ~/.codebuddy/projects，WorkBuddy 应用在 ~/.workbuddy/projects，
// CodeBuddy 应用读 ~/.codebuddy/projects。导入时要两边都落一份，并在 WorkBuddy 侧补 meta。
const WB_PROJECTS = "C:////Users////13694////.workbuddy////projects";


// 按应用自己的 encodeImportedTranscript 生成文件：session-meta + custom-title + message(parentId 链)
function encodeForApp(sessionId, cwd, title, lines, sourceId) {
  const messages = [];
  for (const line of lines) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.type !== "message") continue;
    const text = (item.content ?? [])
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    messages.push({ role, text, timestamp: item.timestamp ?? Date.now() });
  }
  const createdAt = messages[0]?.timestamp ?? Date.now();
  const out = [
    { type: "session-meta", id: `${sessionId}-meta`, sessionId, timestamp: createdAt, meta: { cwd, importedFrom: sourceId, importSourceKey: sourceId } },
    { type: "custom-title", id: `${sessionId}-title`, sessionId, customTitle: title, timestamp: createdAt },
  ];
  let requestId = "";
  let parent;
  messages.forEach((msg, index) => {
    if (msg.role === "user") requestId = `${sessionId}-request-${index}`;
    const id = createHash("sha256").update(`${sessionId}:${index}`).digest("hex").slice(0, 32);
    out.push({
      type: "message",
      id,
      sessionId,
      cwd,
      parentId: parent,
      logicalParentId: parent ?? id,
      role: msg.role,
      timestamp: msg.timestamp,
      content: [{ type: msg.role === "user" ? "input_text" : "output_text", text: msg.text }],
      status: "completed",
      providerData: { conversationRequestId: requestId, importedFrom: sourceId },
    });
    parent = id;
  });
  return out.map((item) => JSON.stringify(item)).join("\n") + "\n";
}


// 三个 home 各有一套库和 projects：WorkBuddy(5.x)、WorkBuddy AI、CLI
const APP_HOMES = [
  { name: "WorkBuddy", home: "C:////Users////13694////.workbuddy" },
  { name: "WorkBuddy AI", home: "C:////Users////13694////.workbuddy-ai" },
];

// 按目标 home 的 sessions 表结构动态拼 INSERT：两个版本的列不完全一样
async function registerInHomeDb(home, sessionId, targetCwd, title, atMs) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return { ok: false, error: "node:sqlite 不可用" };
  }
  const dbFile = path.join(home, "workbuddy.db");
  const exists = await stat(dbFile).catch(() => null);
  if (!exists) return { ok: false, error: "没有库文件" };

  const db = new sqlite.DatabaseSync(dbFile);
  try {
    const cwd = targetCwd.replace(/\\/g, "/");
    const columns = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
    const sibling = db.prepare("SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1").get(cwd)
      ?? db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1").get();

    const wanted = {
      id: sessionId,
      cwd,
      user_id: sibling?.user_id ?? null,
      title,
      custom_title: title,
      status: "completed",
      created_at: atMs,
      updated_at: atMs,
      last_activity_at: atMs,
      deleted_at: null,
      is_playground: sibling?.is_playground ?? 0,
      source_mode: sibling?.source_mode ?? "craft",
      is_background_automation: 0,
      mode: sibling?.mode ?? "craft",
      model: sibling?.model ?? "auto",
      permission_mode: sibling?.permission_mode ?? "fullAccess",
      use_sandbox_cli: sibling?.use_sandbox_cli ?? 1,
      context_window: sibling?.context_window ?? 1000000,
      thought_level: sibling?.thought_level ?? "high",
      transport: "local",
      conversation_origin: "local",
      space_id: sibling?.space_id ?? null,
    };

    const fields = Object.keys(wanted).filter((key) => columns.includes(key));
    const values = fields.map((key) => wanted[key]);
    const placeholders = fields.map(() => "?").join(",");
    const updates = fields.filter((key) => key !== "id").map((key) => `${key}=?`).join(",");
    const sql = `INSERT INTO sessions (${fields.join(",")}) VALUES (${placeholders})
                 ON CONFLICT(id) DO UPDATE SET ${updates}`;
    db.prepare(sql).run(...values, ...values.filter((_, i) => fields[i] !== "id"));

    // 工作目录也登记一下，侧栏才认这个空间
    try {
      if (columns.includes("space_id") && wanted.space_id) {
        db.prepare("INSERT OR IGNORE INTO workspaces (path, last_opened_at) VALUES (?, ?)").run(targetCwd.replace(/\\/g, "\\"), atMs);
      }
    } catch {}
    return { ok: true, home: path.basename(home) };
  } finally {
    db.close();
  }
}

async function writeWorkBuddyCopy(home, sessionId, targetCwd, title, atMs, text) {
  const bucket = path.join(home, "projects", slugOfCwd(targetCwd));
  await mkdir(bucket, { recursive: true });
  const file = path.join(bucket, `${sessionId}.jsonl`);
  const refined = encodeForApp(sessionId, targetCwd, title, text.split(/\r?\n/).filter(Boolean), "agent-autoloop");
  await writeFile(file, refined, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean).length;
  const meta = {
    createdAt: atMs,
    updatedAt: atMs,
    sourceConversationId: sessionId,
    messageCount: lines,
    itemCount: lines,
    requestCount: 1,
    isPlayground: false,
    cwd: targetCwd,
    model: "auto",
    title,
  };
  await writeFile(path.join(bucket, `${sessionId}.meta.json`), JSON.stringify(meta, null, 2), "utf8");
  return { bucket, file };
}


// 桌面端左栏不是扫目录，读的是这份快照；不登记进去就永远看不到。
const SIDEBAR_GLOB_ROOT = "C:////Users////13694////.workbuddy";

async function findSidebarSnapshots() {
  const out = [];
  let dirs = [];
  try {
    dirs = await readdir(SIDEBAR_GLOB_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(SIDEBAR_GLOB_ROOT, dir.name, "sidebar-list-snapshot.json");
    const info = await stat(file).catch(() => null);
    if (info) out.push({ file, mtime: info.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.map((item) => item.file);
}

async function registerInSidebar(sessionId, title, targetCwd, atMs) {
  const done = [];
  const spaceName = targetCwd.replace(/\\/g, "/");
  for (const file of await findSidebarSnapshots()) {
    try {
      const raw = await readFile(file, "utf8");
      const data = JSON.parse(raw);
      const items = Array.isArray(data.items) ? data.items : [];
      const hit = items.find((item) => item.id === sessionId);
      if (hit) {
        hit.title = title;
        hit.updatedAt = atMs;
        hit.lastActivityAt = atMs;
      } else {
        // 桌面端校验很严：缺 isPinned(boolean) 会让整份快照判为无效、被丢弃
        items.unshift({
          id: sessionId,
          title,
          state: "idle",
          transport: "local",
          kind: "task",
          lastActivityAt: atMs,
          isPinned: false,
          cwd: targetCwd,
          conversationOrigin: "local",
          updatedAt: atMs,
          isUserDefinedTitle: 1,
          space: { type: "local", name: spaceName },
        });
      }
      data.items = items;
      data.savedAt = Date.now();
      await writeFile(`${file}.bak`, raw, "utf8");
      await writeFile(file, JSON.stringify(data), "utf8");
      done.push(file);
    } catch {}
  }
  return done;
}

async function rememberInCodeBuddy(sessionId, cwd, title, atMs) {
  const written = [];
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return written;
  }
  for (const file of CB_DBS) {
    try {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const db = new sqlite.DatabaseSync(file);
      let userId = "";
      try {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key LIKE 'session:%' LIMIT 1").get();
        if (row?.value) userId = JSON.parse(row.value).userId ?? "";
      } catch {}
      const value = JSON.stringify({
        conversationId: sessionId,
        cwd: cwd.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`),
        userId,
        title,
        status: "Completed",
        createdAt: atMs,
        updatedAt: atMs,
      });
      db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(`session:${sessionId}`, value);
      db.close();
      written.push(file);
    } catch {}
  }
  return written;
}

async function importSession(input) {
  // 路径可能来自不同调用方（正斜杠/反斜杠混用），一律归一再比
  const sourcePath = path.resolve(String(input.sessionPath ?? "").replace(/\//g, "\\"));
  const root = path.resolve(CLI_PROJECTS);
  const targetCwd = path.resolve(String(input.targetCwd ?? ""));
  const removeSource = Boolean(input.removeSource);
  if (!sourcePath.startsWith(root)) throw new Error("会话路径不在会话库里");
  if (!input.targetCwd) throw new Error("没选目标项目");
  const info = await stat(targetCwd).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`目标目录不存在：${targetCwd}`);
  const sourceInfo = await stat(sourcePath).catch(() => null);
  if (!sourceInfo) throw new Error("找不到这个会话文件");
  // 文件刚被写过，可能是正在跑的会话，复制会拿到半行
  if (Date.now() - sourceInfo.mtimeMs < 5000) throw new Error("这个会话刚写入过，可能还在跑，稍后再导入");

  const bucket = path.join(CLI_PROJECTS, slugOfCwd(targetCwd));
  await mkdir(bucket, { recursive: true });
  const target = path.join(bucket, path.basename(sourcePath));
  const exists = await stat(target).catch(() => null);
  if (exists) throw new Error("目标项目里已有同号会话，先删掉再导");

  // 把每行的 cwd 改成目标项目，避免 IDE 按 cwd 过滤时漏掉
  const text = await readFile(sourcePath, "utf8");
  const rewritten = text.replace(/"cwd"\s*:\s*"[^"]*"/g, `"cwd":${JSON.stringify(targetCwd)}`);
  await writeFile(target, rewritten, "utf8");
  if (removeSource) await unlink(sourcePath).catch(() => {});
  // 应用侧也要落一份：WorkBuddy 读 ~/.workbuddy/projects，CodeBuddy 读 ~/.codebuddy/projects
  const sessionId = path.basename(sourcePath, ".jsonl");
  const title = String(input.title ?? "").trim() || "导入的会话";
  const atMs = Math.round(sourceInfo.mtimeMs || Date.now());
  // 两个应用各写一份 transcript
  const appCopies = [];
  for (const target of APP_HOMES) {
    try {
      const copied = await writeWorkBuddyCopy(target.home, sessionId, targetCwd, title, atMs, rewritten);
      appCopies.push({ home: target.name, ...copied });
    } catch (error) {
      appCopies.push({ home: target.name, error: error.message });
    }
  }
  const appCopy = appCopies[0];
  const written = await rememberInCodeBuddy(sessionId, targetCwd, title, atMs);
  const sidebar = await registerInSidebar(sessionId, title, targetCwd, atMs);
  const dbResult = [];
  for (const target of APP_HOMES) {
    try {
      dbResult.push(await registerInHomeDb(target.home, sessionId, targetCwd, title, atMs));
    } catch (error) {
      dbResult.push({ ok: false, home: target.name, error: error.message });
    }
  }
  return { path: target, project: targetCwd, bucket: path.basename(bucket), indexed: written, appCopy: appCopies, sidebar, db: dbResult };
}

// 中台只存最后一行结论，完整对话在 CLI 自己的会话文件里（~/.codebuddy/projects/<cwd>/<id>.jsonl）。
// 这里按轮次的时间窗去找那条会话，把它转成可读的时间线。
async function findSessionFile(startMs, endMs) {
  let best = null;
  let dirs;
  try {
    dirs = await readdir(CLI_PROJECTS, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files;
    try {
      files = await readdir(path.join(CLI_PROJECTS, dir.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(CLI_PROJECTS, dir.name, name);
      try {
        const info = await stat(full);
        if (info.mtimeMs < startMs - 120000 || info.mtimeMs > endMs + 300000) continue;
        if (!best || info.size > best.size) best = { path: full, size: info.size, mtime: info.mtimeMs };
      } catch {}
    }
  }
  return best;
}

// 把会话文件开头那段「中台按规则…把这件活派给你」的套话剥掉，留业务描述做预览。
function previewOf(text) {
  let cwd = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof item.cwd === "string") cwd = item.cwd;
    if (item.type !== "message" || item.role !== "user") continue;
    let content = (item.content ?? [])
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text)
      .join(" ");
    // 去掉中台加的那段套话：「按规则…把这件活派给你。发生了：- 本机 xxx」
    content = content
      .replace(/Agent 自动化中台[\s\S]*?发生了：/, " ")
      .replace(/^\s*[-–]\s*本机[^\n]*/m, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (content) return { preview: content.slice(0, 120), cwd };
  }
  return { preview: "", cwd };
}

// 有些会话是早期用 command 模式跑的，轮次里没留下会话号，靠这个文件手工认领
async function readClaims() {
  try {
    return JSON.parse(await readFile(CLAIMS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function agentIndex() {
  const map = new Map();
  let state;
  try {
    state = await hub("/v1/state");
  } catch {
    return map;
  }
  const names = new Map((state.agents ?? []).map((agent) => [agent.id, agent.name]));
  // 旧轮次里记的 agent id 可能已经被合并/改名，映射回现名
  const RENAMED = { "codebuddy-acp": "codebuddy" };
  for (const run of state.runs ?? []) {
    if (!run.session || map.has(run.session)) continue;
    const agentId = RENAMED[run.agent] ?? run.agent;
    map.set(run.session, { agent: names.get(agentId) ?? agentId ?? "未知", rule: run.rule, at: run.createdAt });
  }
  // 认领记录优先于轮次推断
  for (const [sessionId, claim] of Object.entries(await readClaims())) {
    map.set(sessionId, { agent: claim.agent ?? "手工认领", rule: claim.rule ?? "（认领）", at: claim.at ?? new Date().toISOString() });
  }
  return map;
}

function stampOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortTitle(text, limit = 34) {
  const first = (text ?? "").split(/[。！？\n]/)[0].trim();
  const value = first || (text ?? "").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

async function listSessions(keyword) {
  const index = await agentIndex();
  const found = [];
  let dirs = [];
  try {
    dirs = await readdir(CLI_PROJECTS, { withFileTypes: true });
  } catch {
    return found;
  }
  const word = (keyword ?? "").trim();
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files = [];
    try {
      files = await readdir(path.join(CLI_PROJECTS, dir.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(CLI_PROJECTS, dir.name, name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      const id = name.replace(/\.jsonl$/, "");
      let preview = "";
      let sessionCwd = "";
      let matched = false;
      try {
        const handle = await open(full, "r");
        const buffer = Buffer.alloc(6000);
        const { bytesRead } = await handle.read(buffer, 0, 6000, 0);
        await handle.close();
        const head = previewOf(buffer.subarray(0, bytesRead).toString("utf8"));
        preview = head.preview;
        sessionCwd = head.cwd;
        if (word && !preview.includes(word) && info.size <= 512 * 1024) {
          matched = (await readFile(full, "utf8")).includes(word);
        }
      } catch {}
      if (word && !preview.includes(word) && !matched && !dir.name.includes(word)) continue;
      const known = index.get(id);
      found.push({
        project: dir.name,
        cwd: sessionCwd,
        projectLabel: dir.name.replace(/^c-Users-13694-/i, "").replace(/-/g, "\\"),
        id,
        path: full,
        size: info.size,
        mtime: info.mtimeMs,
        preview,
        agent: known?.agent ?? "无会话号的运行",
        rule: known?.rule ?? "",
        label: known ? String(known.rule).replace(/^会话·/, "") : shortTitle(preview),
      });
    }
  }
  // dsh（DeepSeek Harness）的会话是 zstd 压缩的，单独扫一遍并进来。
  // 之前把中台会话全量镜像进 dsh，导致同一条会话在两个分组里各出现一次；
  // 这里把「id 与中台会话相同」的镜像过滤掉，只留 dsh 自己的。
  const cliIds = new Set(found.map((item) => item.id));
  try {
    for (const item of await listDshSessions()) {
      const rawId = String(item.id).replace(/^session-/, "");
      if (cliIds.has(rawId)) continue;
      if (word && !String(item.cwd).includes(word) && !String(item.title ?? "").includes(word)) continue;
      found.push({
        project: `--${item.cwd}--`,
        cwd: item.cwd,
        projectLabel: item.cwd,
        id: item.id.replace(/^session-/, ""),
        path: item.path,
        size: item.events,
        mtime: item.mtime,
        preview: item.title ?? "",
        agent: "DeepSeek Harness",
        rule: item.title ?? "dsh 会话",
        label: `${item.title ?? "dsh 会话"} · ${stampOf(item.createdAt)}`,
        dsh: true,
      });
    }
  } catch {}

  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, 300);
}

// 从工具调用参数里捞出被写的文件，作为「产物」；助手说的话单独抽出来当「思维链」。
function analyzeSession(text) {
  const lines = [];
  const artifacts = [];
  const thoughts = [];
  const seen = new Set();
  const pathKeys = ["file_path", "filePath", "path", "target_file", "notebook_path", "abs_path"];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.type === "message") {
      const content = (item.content ?? []).filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n").trim();
      if (!content) continue;
      const kind = item.role === "user" ? "user" : "assistant";
      lines.push({ kind, text: content.slice(0, 4000), at: item.timestamp });
      if (kind === "assistant") thoughts.push(content);
    } else if (item.type === "function_call") {
      lines.push({ kind: "call", name: item.name, text: String(item.arguments ?? "").slice(0, 500), at: item.timestamp });
      // 只有写/改类工具才算产物；Read 进来的是素材，不是产出
      if (/write|edit|create|patch|apply|notebook/i.test(String(item.name ?? ""))) {
        try {
          const args = JSON.parse(item.arguments ?? "{}");
          for (const key of pathKeys) {
            const value = args?.[key];
            if (typeof value === "string" && /[\\/]/.test(value) && !seen.has(value)) {
              seen.add(value);
              artifacts.push({ path: value, tool: item.name });
            }
          }
        } catch {}
      }
    } else if (item.type === "function_call_result") {
      lines.push({ kind: "result", name: item.name, status: item.status, text: String(item.output ?? "").slice(0, 800), at: item.timestamp });
    }
  }
  return { lines, artifacts: artifacts.slice(-60), thoughts };
}

function parseTranscript(text) {  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.type === "message") {
      // 部件类型不止一种：输入是 input_text，回复是 output_text，还有纯 text。
      const content = (item.content ?? [])
        .filter((part) => typeof part?.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (content) out.push({ kind: item.role === "user" ? "user" : "assistant", text: content.slice(0, 4000), at: item.timestamp });
    } else if (item.type === "function_call") {
      out.push({ kind: "call", name: item.name, text: String(item.arguments ?? "").slice(0, 500), at: item.timestamp });
    } else if (item.type === "function_call_result") {
      out.push({ kind: "result", name: item.name, status: item.status, text: String(item.output ?? "").slice(0, 800), at: item.timestamp });
    }
  }
  return out;
}


// 会话同步常驻进程：控制台起来就把同步带起来，避免忘了手动开
let syncChild = null;
function startSyncWorker() {
  if (syncChild) return;
  try {
    syncChild = spawn(process.execPath, [path.join(process.cwd(), "sync.mjs"), "--watch"], { stdio: "ignore", windowsHide: true });
    syncChild.on("exit", () => { syncChild = null; });
  } catch {}
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/api/state") {
      return json(response, 200, await hub("/v1/state"));
    }
    if (url.pathname === "/api/act" && request.method === "POST") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw || "{}");
      const result = await act(input);
      // 动作之后立刻回一份新状态，前端不用等下一轮轮询。
      return json(response, 200, { ok: true, result, state: await hub("/v1/state") });
    }
    if (url.pathname === "/api/sessions") {
      const keyword = url.searchParams.get("q") ?? "";
      return json(response, 200, { ok: true, sessions: await listSessions(keyword) });
    }
    if (url.pathname === "/api/dsh/new" && request.method === "POST") {
      let body = {};
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const cwd = String(body.cwd ?? "").trim();
      const title = String(body.name ?? "").trim() || "中台会话";
      const prompt = String(body.prompt ?? "").trim();
      if (!cwd) return json(response, 400, { ok: false, error: "没选工作目录" });
      const sessionId = uuidv4();
      // 先写一条用户消息，dsh 里才有内容可看；后续由同步继续补
      const messages = prompt ? [{ role: "user", text: prompt, at: Date.now() }] : [];
      const result = await writeDshSession({ cwd, title, messages, sessionId });
      return json(response, 200, { ok: true, sessionId, ...result });
    }
    if (url.pathname === "/api/session") {
      const file = url.searchParams.get("path") ?? "";
      const resolved = path.resolve(file);
      const isDsh = resolved.startsWith(path.resolve("C:////Users////13694////.dsh////sessions"));
      // 只允许读两处会话目录，挡掉路径穿越
      if (!isDsh && !resolved.startsWith(path.resolve(CLI_PROJECTS))) return json(response, 403, { ok: false, error: "不在会话目录里" });
      const info = await stat(resolved).catch(() => null);
      if (!info) return json(response, 404, { ok: false, error: "找不到这个会话" });
      const raw = isDsh ? await readDshAsCli(resolved) : await readFile(resolved, "utf8");
      const analysis = analyzeSession(raw);
      return json(response, 200, { ok: true, path: resolved, size: info.size, ...analysis });
    }
    if (url.pathname === "/api/transcript") {
      const id = Number(url.searchParams.get("run"));
      const state = await hub("/v1/state");
      const run = (state.runs ?? []).find((item) => item.id === id);
      if (!run) return json(response, 404, { ok: false, error: "找不到这一轮" });
      const start = new Date(run.createdAt).getTime();
      const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
      const file = await findSessionFile(start, end);
      if (!file) return json(response, 200, { ok: true, found: false });
      const lines = parseTranscript(await readFile(file.path, "utf8"));
      return json(response, 200, { ok: true, found: true, path: file.path, size: file.size, lines });
    }

    if (url.pathname === "/api/agents") {
      const state = await hub("/v1/state");
      let rules = { agents: {} };
      try { rules = await readRules(); } catch {}
      return json(response, 200, {
        ok: true,
        agents: [...(state.agents ?? []).map((agent) => {
          const use = rules.agents?.[agent.id]?.use ?? "command";
          return { id: agent.id, name: agent.name, online: agent.online, use, supportsSession: use === "acp" };
        }),
        // dsh 不是 hub 的 Agent，但它是我们接的 harness，也要能被选中/显示
        { id: "dsh", name: "DeepSeek Harness", online: true, use: "dsh", supportsSession: true }],
      });
    }
    if (url.pathname === "/api/session/new" && request.method === "POST") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw || "{}");
      const result = await createSession(input);
      return json(response, 200, { ok: true, ...result });
    }
    if (url.pathname === "/api/session/prompt" && request.method === "POST") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw || "{}");
      const result = await continueSession(input);
      return json(response, 200, { ok: true, ...result });
    }
    if (url.pathname === "/api/upload" && request.method === "POST") {
      const dir = url.searchParams.get("dir") ?? "";
      const name = decodeURIComponent(url.searchParams.get("name") ?? "file");
      if (!dir || !path.isAbsolute(dir)) return json(response, 400, { ok: false, error: "需要绝对目录" });
      if (/[\\/]/.test(name)) return json(response, 400, { ok: false, error: "文件名不合法" });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const inbox = path.join(dir, "_inbox");
      await mkdir(inbox, { recursive: true });
      const target = path.join(inbox, `${Date.now()}-${name}`);
      await writeFile(target, Buffer.concat(chunks));
      return json(response, 200, { ok: true, path: target });
    }

    if (url.pathname === "/api/projects") {
      return json(response, 200, { ok: true, projects: await listProjects() });
    }
    if (url.pathname === "/api/files") {
      const cwd = url.searchParams.get("cwd") ?? "";
      if (!cwd || !path.isAbsolute(cwd)) return json(response, 400, { ok: false, error: "需要绝对目录" });
      return json(response, 200, { ok: true, files: await listFiles(cwd, url.searchParams.get("q") ?? "") });
    }
    if (url.pathname === "/api/session/import" && request.method === "POST") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const result = await importSession(JSON.parse(raw || "{}"));
      return json(response, 200, { ok: true, ...result });
    }
    if (url.pathname === "/api/session/more") {
      const file = url.searchParams.get("path") ?? "";
      const since = Number(url.searchParams.get("since") ?? 0);
      const resolved = path.resolve(file);
      if (!resolved.startsWith(path.resolve(CLI_PROJECTS))) return json(response, 403, { ok: false, error: "不在会话目录里" });
      let buffer;
      try {
        buffer = await readFile(resolved);
      } catch {
        return json(response, 404, { ok: false, error: "找不到会话" });
      }
      if (buffer.length <= since) return json(response, 200, { ok: true, lines: [], offset: buffer.length, grew: false });
      const fresh = buffer.subarray(since).toString("utf8");
      const analysis = analyzeSession(fresh);
      return json(response, 200, { ok: true, lines: analysis.lines, artifacts: analysis.artifacts, offset: buffer.length, grew: true });
    }
    if (url.pathname === "/api/health") {
      const state = await hub("/v1/state");
      return json(response, 200, { ok: true, seq: state.seq, hub: HUB });
    }
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = path.join(PUBLIC, path.normalize(file).replace(/^([/\\])+/, ""));
    if (!target.startsWith(PUBLIC)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    const content = await readFile(target);
    response.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (url.pathname.startsWith("/api/")) return json(response, 502, { ok: false, error: message });
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(`没有这个地址：${message}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Console ready: http://127.0.0.1:${PORT}   (hub ${HUB})`);
  startSyncWorker();
  console.log("会话同步进程已启动");
});
