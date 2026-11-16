// 极简 CDP 客户端：连 Electron 的调试端口，执行一段 JS 并把结果打回来。
// 用法：node cdp.mjs "表达式" [port]
import http from "node:http";
import crypto from "node:crypto";

const expression = process.argv[2] ?? "document.title";
const port = process.argv[3] ?? "9224";

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

class WS {
  constructor(url) {
    const u = new URL(url);
    this.key = crypto.randomBytes(16).toString("base64");
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.onmessage = () => {};
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.path = u.pathname + (u.search || "");
  }

  connect() {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.host,
        port: this.port,
        path: this.path,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": this.key,
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("upgrade", (res, socket) => {
        this.socket = socket;
        socket.on("data", (chunk) => this.handle(chunk));
        resolve();
      });
      req.on("error", reject);
      req.end();
    });
  }

  handle(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let len = second & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      const opcode = first & 0x0f;
      if (opcode === 1) this.onmessage(payload.toString("utf8"));
      if (opcode === 8) this.socket.end();
    }
  }

  send(text) {
    const data = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | data.length;
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    header[0] = 0x81;
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
}

const list = JSON.parse(await httpGet("/json/list"));
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("找不到页面目标");
  process.exit(1);
}
const ws = new WS(page.webSocketDebuggerUrl);
await ws.connect();

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("超时")), 20000);
  ws.onmessage = (text) => {
    const msg = JSON.parse(text);
    if (msg.id !== 1) return;
    clearTimeout(timer);
    resolve(msg);
  };
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true },
  }));
});

if (result.result?.exceptionDetails) {
  console.log("EXCEPTION:", result.result.exceptionDetails.text, result.result.exceptionDetails.exception?.description?.slice(0, 400));
} else {
  const value = result.result?.result?.value;
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 1));
}
process.exit(0);
