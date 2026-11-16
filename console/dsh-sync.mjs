// dsh（DeepSeek Harness）适配器。
// 读：~/.dsh/sessions/<--cwd-->/*/session.v4.jsonl.zstd（zstd + JSONL）
// 写：必须先有一条“真实已有内容”的 dsh 会话作为模板，否则格式中的事件封装无法确认，
//     盲写可能让 dsh 拒绝整个会话库，所以没有模板时直接拒绝。
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = "C:\\Users\\13694\\.dsh\\sessions";

export const sessionDirName = (cwd) => {
  const normalized = cwd.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`).replace(/[:\\/]/g, "-").replace(/-+/g, "-");
  return `--${normalized}--`;
};
export const normalizeCwd = (cwd) => cwd.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);

async function readSession(file) {
  const raw = zstdDecompressSync(await readFile(file)).toString("utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const cache = new Map(); // path → { mtime, payload }，避免每次列表都解压一遍

export async function listDshSessions() {
  const out = [];
  let buckets = [];
  try {
    buckets = await readdir(ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = path.join(ROOT, bucket.name);
    let dirs = [];
    try {
      dirs = await readdir(bucketPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = path.join(bucketPath, dir.name, "session.v4.jsonl.zstd");
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const cached = cache.get(file);
      let records;
      if (cached && cached.mtime === info.mtimeMs) {
        records = cached.records;
      } else {
        try {
          records = await readSession(file);
        } catch {
          continue;
        }
        cache.set(file, { mtime: info.mtimeMs, records });
      }
      const header = records.find((item) => item.type === "session");
      const titleRec = records.find((item) => item.type === "session/title");
      const firstUser = records.find((item) => item.type === "user/message");
      const firstText = (firstUser?.data?.content ?? []).map((c) => c.text).filter(Boolean).join(" ").trim();
      out.push({
        id: header?.id ?? dir.name,
        cwd: header?.cwd ?? "",
        createdAt: header?.createdAt ?? info.mtimeMs,
        mtime: info.mtimeMs,
        title: (titleRec?.data?.title ?? "").trim() || firstText.slice(0, 24) || "未命名会话",
        events: records.length - 1,
        path: file,
      });
    }
  }
  return out;
}

// 从一个“有事件”的真实会话里推断事件记录的外层结构（type/seq/time/data 之类）
export async function findTemplate() {
  for (const session of await listDshSessions()) {
    if (session.events < 1) continue;
    try {
      const records = await readSession(session.path);
      const sample = records.find((item) => item.type !== "session");
      if (sample) return { session, sample, keys: Object.keys(sample) };
    } catch {}
  }
  return null;
}

export async function writeDshSession({ cwd, title, messages, sessionId }) {
  // 事件形状取自 dsh 自己写出来的真实会话（session-bac2dbba…）
  const dir = path.join(ROOT, sessionDirName(cwd), `session-${sessionId}`);
  await mkdir(dir, { recursive: true });
  const createdAt = messages[0]?.at ?? Date.now();
  const zone = "Asia/Shanghai";
  const lines = [
    JSON.stringify({
      type: "session", version: 4, id: `session-${sessionId}`, createdAt,
      cwd: normalizeCwd ? normalizeCwd(cwd) : cwd, isSeeded: false, delegationDepth: 0, agentPreset: "standard",
    }),
    JSON.stringify({ type: "permission/preset", seq: 0, time: createdAt, data: { preset: "workspace-write" } }),
    JSON.stringify({ type: "sandbox/mode", seq: 1, time: createdAt, data: { mode: "workspace-write" } }),
    JSON.stringify({ type: "approval/policy", seq: 2, time: createdAt, data: { policy: "ask" } }),
  ];
  let seq = 3;
  let turn = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role === "user") {
      turn += 1;
      lines.push(JSON.stringify({ type: "turn/start", seq: seq++, time: msg.at ?? createdAt, data: { turn } }));
      lines.push(JSON.stringify({
        type: "user/message", seq: seq++, time: msg.at ?? createdAt, surfaceOp: "append",
        data: {
          content: [{ type: "text", text: msg.text }],
          source: { kind: "user", rpcId: crypto.randomUUID(), clientTimeZone: zone },
          role: "user", id: crypto.randomUUID(),
        },
      }));
    } else {
      lines.push(JSON.stringify({ type: "step/start", seq: seq++, time: msg.at ?? createdAt, data: { turn: Math.max(turn, 1), step: 1 } }));
      lines.push(JSON.stringify({
        type: "assistant/message", seq: seq++, time: msg.at ?? createdAt, surfaceOp: "append",
        data: {
          turn: Math.max(turn, 1), step: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: msg.text }],
            source: { kind: "model", provider: "buddy", model: "deepseek-v4.1-flash" },
            id: crypto.randomUUID(),
          },
          usage: { inputTokens: 0, outputTokens: 0 },
          stream: [],
        },
      }));
      lines.push(JSON.stringify({ type: "turn/end", seq: seq++, time: msg.at ?? createdAt, data: { turn: Math.max(turn, 1), reason: { kind: "completed" } } }));
      turn += 1;
    }
  }
  const firstUserSeq = lines.findIndex((line) => line.includes('"user/message"'));
  lines.push(JSON.stringify({
    type: "session/title", seq: seq++, time: createdAt,
    data: { title, messageSeqs: firstUserSeq > 0 ? [firstUserSeq] : [], source: { kind: "fallback" } },
  }));
  await writeFile(path.join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
  return { ok: true, path: dir, events: lines.length - 1 };
}

if (process.argv[1]?.endsWith("dsh-sync.mjs")) {
  const list = await listDshSessions();
  console.log(`dsh 会话 ${list.length} 条：`);
  for (const item of list) console.log(`  ${item.id}  events=${item.events}  ${item.cwd}`);
  const tpl = await findTemplate();
  console.log(tpl ? `找到模板：${tpl.session.id}，事件字段 ${tpl.keys.join(",")}` : "没有可用模板（dsh 里还没有发过消息的会话）");
}

// 把 dsh 会话转成 CLI 风格的 jsonl 文本，好让中台复用同一套解析
export async function readDshAsCli(file) {
  const records = await readSession(file);
  const out = [];
  for (const item of records) {
    if (item.type === "user/message") {
      const text = (item.data?.content ?? []).map((c) => c.text).filter(Boolean).join("\n");
      if (text) out.push({ type: "message", role: "user", timestamp: item.time, content: [{ type: "text", text }] });
    } else if (item.type === "assistant/message") {
      const text = (item.data?.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text) out.push({ type: "message", role: "assistant", timestamp: item.time, content: [{ type: "text", text }] });
    } else if (item.type === "tool/call") {
      out.push({ type: "function_call", name: item.data?.name, arguments: item.data?.arguments, timestamp: item.time });
    }
  }
  return out.map((x) => JSON.stringify(x)).join("\n") + "\n";
}
