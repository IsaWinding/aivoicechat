import { writeFileSync } from "node:fs";
import { SpokenReplyComposer, type SpokenReplyContext } from "../src/spokenReply";

async function main(): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error("请通过进程环境提供 CURSOR_API_KEY");
  const composer = new SpokenReplyComposer();
  const options = { apiKey, model: "composer-2.5", cwd: process.cwd() };
  const common: SpokenReplyContext = {
    latestQuestion: "现在可以上线了吗？",
    recentConversation: [{ role: "user", text: "我最关心登录会不会失败，不需要逐项讲代码。" }],
    fullResult: "按钮样式已调整，重复点击问题已修复。\n\n" +
      Array.from({ length: 60 }, (_, i) => `进度 ${i + 1}：读取 src/component${i}.ts，运行 npm test，检查组件。`).join("\n") +
      "\n\n最终验证：登录接口在弱网下仍会超时，登录测试失败。尚不能上线。按钮相关测试已通过。下一步处理登录超时，再做回归验证。",
    status: "finished", importantEvents: ["登录测试失败，弱网请求超时"], previousReplies: [], language: "zh-CN",
  };
  const rows = [];
  for (const [name, context] of [
    ["tail-failure", common],
    ["follow-up-why", { ...common, latestQuestion: "为什么登录还不行？就说原因。", previousReplies: [{ text: "暂时不能上线，登录在弱网下还会超时。", delivery: "requested" }] }],
    ["failed-task", { ...common, status: "error", latestQuestion: "都完成了吗？", fullResult: "页面样式已修改；保存失败，后续验证没有执行。", importantEvents: ["保存失败"] }],
  ] as [string, SpokenReplyContext][]) {
    const started = performance.now();
    const reply = await composer.compose(options, context);
    const row = { name, generationMs: Math.round(performance.now() - started), ...reply };
    rows.push(row);
    console.log(JSON.stringify(row));
    if (!reply || reply.fallback) throw new Error(`${name}: 真实口语生成不可用`);
    if (name === "tail-failure" && !/不能|不建议|暂时|还不/.test(reply.text)) throw new Error("遗漏不可上线结论");
    if (name === "follow-up-why" && !/弱网|超时|网络/.test(reply.text)) throw new Error("未解释最新追问的原因");
    if (name === "failed-task" && !/失败|未|没有|还没/.test(reply.text)) throw new Error("错误地报告全部完成");
  }
  writeFileSync("out/live-spoken-results.json", JSON.stringify(rows, null, 2));
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
