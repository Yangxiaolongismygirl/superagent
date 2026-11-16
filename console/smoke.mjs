// 不开浏览器，用假 DOM 跑一遍页面的 render，确认渲染逻辑真的产出了内容。
import { readFileSync } from "node:fs";

const script = readFileSync("C:/Users/13694/WorkBuddy/spaces/2026_11_13_10-36-44/autoloop-console/public/app.js", "utf8");

const state = await (await fetch("http://127.0.0.1:3360/api/state")).json();

const elements = new Map();
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
const makeElement = (id) => ({
  id,
  textContent: "",
  innerHTML: "",
  className: "",
  value: "",
  style: {},
  dataset: {},
  scrollTop: 0,
  scrollHeight: 0,
  addEventListener() {},
  focus() {},
  select() {},
  classList: { toggle() {}, add() {}, remove() {} },
});
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  addEventListener() {},
  title: "",
};

const fetchStub = async () => ({ json: async () => state });
const setIntervalStub = () => 0;

new Function("document", "fetch", "setInterval", "location", script)(document, fetchStub, setIntervalStub, { origin: "http://127.0.0.1:3360" });

await new Promise((resolve) => setTimeout(resolve, 50));

// 带候选卡片跑一遍，确认选项按钮也生成了
const withCard = structuredClone(state);
withCard.cards = [{
  id: 99, kind: "ask", title: "试跑：选一个颜色", text: "这是一次试跑。", options: ["蓝色", "绿色"],
  rule: "试一下", state: "open", createdAt: new Date().toISOString(),
}];
elements.clear();
new Function("document", "fetch", "setInterval", "location", script)(document, async () => ({ json: async () => withCard }), setIntervalStub, { origin: "http://127.0.0.1:3360" });
await new Promise((resolve) => setTimeout(resolve, 50));

const pick = (id, needle) => (elements.get(id)?.innerHTML.includes(needle) ? "✓" : "✗");
const firstRun = state.runs?.[0]?.id;
const rows = [
  ["规则区渲染出规则名", state.lines?.[0] ? pick("rulesBody", state.lines[0].name) : "跳过（没有规则）"],
  ["规则区有操作按钮", pick("rulesBody", "立即运行")],
  [`轮次区渲染出 #${firstRun}`, firstRun ? pick("runsBody", `#${firstRun}`) : "跳过"],
  ["在线区渲染出 CodeBuddy", pick("onlineBody", "CodeBuddy")],
  ["历史卡片区渲染出卡片", state.recentCards?.[0] ? pick("histBody", state.recentCards[0].title.slice(0, 6)) : "跳过（没有卡片）"],
  ["卡片区渲染出选项按钮", pick("cardsBody", 'class="option"')],
  ["卡片区渲染出自由输入", pick("cardsBody", "或者直接写你的决定")],
  ["KPI 在跑数字", elements.get("kRunning")?.textContent === undefined ? "✗" : "✓"],
  ["连接状态", elements.get("connText")?.textContent ?? ""],
];
for (const [name, result] of rows) console.log(`${result}  ${name}`);
