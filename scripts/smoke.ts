import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession } from "../src/agentSession";
import { interpretSdkEvent, summarizeForSpeech } from "../src/progress";

const root = process.cwd();

function readApiKey(): string {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const settings = JSON.parse(readFileSync(join(root, ".vscode", "settings.json"), "utf8")) as {
      "aivoicechat.apiKey"?: string;
    };
    return settings["aivoicechat.apiKey"]?.trim() || "";
  } catch {
    return "";
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testProgress(): void {
  const read = interpretSdkEvent({
    type: "tool_call",
    name: "Read",
    status: "running",
    args: { path: "E:/repo/src/extension.ts" },
  });
  assert(read?.text === "正在阅读 src/extension.ts", `read notice: ${read?.text}`);
  assert(read?.speak === false, "read should not speak");

  const edit = interpretSdkEvent({
    type: "tool_call",
    name: "StrReplace",
    status: "running",
    args: { filePath: "src/chatPanel.ts" },
  });
  assert(edit?.text === "正在修改 src/chatPanel.ts", `edit notice: ${edit?.text}`);
  assert(edit?.speak === false, "edit progress should stay silent");

  const done = interpretSdkEvent({
    type: "tool_call",
    name: "Write",
    status: "completed",
    args: { path: "README.md" },
  });
  assert(done?.text === "已修改 README.md", `done notice: ${done?.text}`);

  const failed = interpretSdkEvent({
    type: "tool_call",
    name: "Shell",
    status: "error",
    args: { command: "npm test" },
  });
  assert(failed?.speak === true && failed.text.includes("失败"), `shell error: ${failed?.text}`);

  const summary = summarizeForSpeech("第一句。第二句比较长。", 20);
  assert(summary === "第一句。", `summary: ${summary}`);
  console.log("[ok] progress mapping");
}

async function testAgent(): Promise<void> {
  const apiKey = readApiKey();
  if (!apiKey) {
    throw new Error("缺少 API Key：请设置 CURSOR_API_KEY 或 .vscode/settings.json");
  }
  if (!apiKey.startsWith("crsr_")) {
    throw new Error("API Key 格式不像 Cursor 密钥");
  }

  const session = new AgentSession();
  const events: string[] = [];
  let streamed = "";
  try {
    await session.ensure({
      apiKey,
      model: "composer-2.5",
      cwd: root,
    });
    const outcome = await session.send(
      "不要修改任何文件，不要运行会改动仓库的命令。只用一两句话说明这个仓库是做什么的。",
      {
        onDelta: (chunk) => {
          streamed += chunk;
        },
        onEvent: (event) => {
          if (event && typeof event === "object" && "type" in event && typeof event.type === "string") {
            const notice = interpretSdkEvent(event);
            events.push(notice ? `${event.type}:${notice.text}` : event.type);
          }
        },
      },
    );

    console.log(`[ok] agent status=${outcome.status}`);
    console.log(`[ok] stream events=${events.length} textChars=${(outcome.result ?? streamed).length}`);
    if (events.length) {
      console.log(`[ok] event types: ${[...new Set(events)].slice(0, 12).join(", ")}`);
    }
    const preview = (outcome.result ?? streamed).replace(/\s+/g, " ").trim().slice(0, 160);
    if (preview) {
      console.log(`[ok] result: ${preview}`);
    }
    if (outcome.status === "error") {
      throw new Error(outcome.errorMessage || "agent returned error");
    }
    if (outcome.status === "cancelled") {
      throw new Error("agent was cancelled");
    }
    if (!(outcome.result ?? streamed).trim()) {
      throw new Error("agent finished without text");
    }
  } finally {
    await session.dispose();
  }
}

async function main(): Promise<void> {
  testProgress();
  await testAgent();
  console.log("[ok] smoke test passed");
}

main().catch((error) => {
  console.error("[fail]", error instanceof Error ? error.message : error);
  process.exit(1);
});
