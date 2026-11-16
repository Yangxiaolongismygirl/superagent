// 会话同步：把中台的会话实时镜像到 WorkBuddy / WorkBuddy AI。
// 判据很简单——会话文件的字节数变了就重新推一遍。
// 用法：node sync.mjs          单次
//       node sync.mjs --watch  常驻，每 5 秒看一次
import { writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { writeDshSession } from "./dsh-sync.mjs";

const CONSOLE_API = "http://127.0.0.1:3360";
const HOMES = [
  { name: "WorkBuddy", home: "C:\\Users\\13694\\.workbuddy" },
  { name: "WorkBuddy AI", home: "C:\\Users\\13694\\.workbuddy-ai" },
];
const WATCH = process.argv.includes("--watch");

const slugOfCwd = (cwd) =>
  cwd.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `${drive.toLowerCase()}-`).replace(/[\\/]/g, "-");

// 按应用的 encodeImportedTranscript 生成会话文件
function encode(sessionId, cwd, title, lines) {
  const messages = [];
  for (const line of lines) {
    if (line.kind !== "user" && line.kind !== "assistant") continue;
    const text = String(line.text ?? "").trim();
    if (!text) continue;
    messages.push({ role: line.kind === "assistant" ? "assistant" : "user", text, timestamp: line.at ?? Date.now() });
  }
  const createdAt = messages[0]?.timestamp ?? Date.now();
  const out = [
    { type: "session-meta", id: `${sessionId}-meta`, sessionId, timestamp: createdAt, meta: { cwd, importedFrom: "agent-autoloop", importSourceKey: "agent-autoloop" } },
    { type: "custom-title", id: `${sessionId}-title`, sessionId, customTitle: title, timestamp: createdAt },
  ];
  let requestId = "";
  let parent;
  messages.forEach((msg, index) => {
    if (msg.role === "user") requestId = `${sessionId}-request-${index}`;
    const id = createHash("sha256").update(`${sessionId}:${index}`).digest("hex").slice(0, 32);
    out.push({
      type: "message", id, sessionId, cwd,
      parentId: parent, logicalParentId: parent ?? id,
      role: msg.role, timestamp: msg.timestamp,
      content: [{ type: msg.role === "user" ? "input_text" : "output_text", text: msg.text }],
      status: "completed",
      providerData: { conversationRequestId: requestId, importedFrom: "agent-autoloop" },
    });
    parent = id;
  });
  return out.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

async function upsert(home, sessionId, cwd, title, atMs, createdAt) {
  const file = path.join(home, "workbuddy.db");
  if (!(await stat(file).catch(() => null))) return "无库";
  const db = new DatabaseSync(file);
  try {
    const columns = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
    const existing = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    const sibling =
      db.prepare("SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1").get(cwd) ??
      db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1").get();
    const row = {
      id: sessionId, cwd, user_id: sibling?.user_id ?? null, title, custom_title: title,
      status: "completed",
      // 续接必须保留首次的创建时间，只更新内容和活跃时间
      created_at: existing?.created_at ?? createdAt,
      updated_at: atMs, last_activity_at: atMs,
      deleted_at: null, is_playground: 0, source_mode: sibling?.source_mode ?? "craft",
      is_background_automation: 0, mode: sibling?.mode ?? "craft", model: sibling?.model ?? "auto",
      permission_mode: sibling?.permission_mode ?? "fullAccess", use_sandbox_cli: 1,
      context_window: sibling?.context_window ?? 1000000, thought_level: sibling?.thought_level ?? "high",
      transport: "local", conversation_origin: "local", space_id: sibling?.space_id ?? null,
    };
    const fields = Object.keys(row).filter((key) => columns.includes(key));
    const updates = fields.filter((key) => key !== "id").map((key) => `${key}=?`).join(",");
    db.prepare(`INSERT INTO sessions (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})
                ON CONFLICT(id) DO UPDATE SET ${updates}`)
      .run(...fields.map((key) => row[key]), ...fields.filter((key) => key !== "id").map((key) => row[key]));
    return "ok";
  } finally {
    db.close();
  }
}

async function push(session, lines) {
  const cwd = String(session.cwd ?? "").replace(/\\/g, "/");
  const sessionId = session.id;
  const transcript = encode(sessionId, cwd, session.label ?? "中台会话", lines);
  const results = [];
  const targets = HOME_BY_AGENT[session.agent] ?? [];
  for (const target of targets) {
    try {
      const bucket = path.join(target.home, "projects", slugOfCwd(cwd));
      await mkdir(bucket, { recursive: true });
      await writeFile(path.join(bucket, `${sessionId}.jsonl`), transcript, "utf8");
      results.push(`${target.name}:${await upsert(target.home, sessionId, cwd, session.label ?? "中台会话", Date.now(), new Date(session.createdAt ?? Date.now()).getTime())}`);
    } catch (error) {
      results.push(`${target.name}:ERR ${error.message}`);
    }
  }
  return results.join(" ") || "无对应 harness";
}

async function syncOnce(seen) {
  let sessions = [];
  try {
    const res = await fetch(`${CONSOLE_API}/api/sessions`, { signal: AbortSignal.timeout(6000) });
    sessions = (await res.json()).sessions ?? [];
  } catch {
    return 0;
  }
  let count = 0;
  for (const session of sessions) {
    if (!session.cwd) continue;
    if (seen.get(session.id) === session.size) continue; // 没变化
    try {
      const detail = await (await fetch(`${CONSOLE_API}/api/session?path=${encodeURIComponent(session.path)}`, { signal: AbortSignal.timeout(10000) })).json();
      if (!detail.ok) continue;
      const lines = detail.lines ?? [];
      // 没有消息的会话不要往 harness 推，否则那边会出现空条目
      if (!lines.some((line) => line.kind === "user" || line.kind === "assistant")) {
        seen.set(session.id, session.size);
        continue;
      }
      const result = await push(session, lines);
      seen.set(session.id, session.size);
      console.log(`[sync] ${session.label} → ${result}`);
      count += 1;
    } catch (error) {
      console.log(`[sync] ${session.label} 失败: ${error.message}`);
    }
  }
  return count;
}

const seen = new Map();
if (WATCH) {
  console.log("会话同步已启动（每 5 秒检查一次）");
  for (;;) {
    await syncOnce(seen);
    await new Promise((r) => setTimeout(r, 5000));
  }
} else {
  const n = await syncOnce(seen);
  console.log(n ? `本次同步 ${n} 条` : "没有变化，无需同步");
}
