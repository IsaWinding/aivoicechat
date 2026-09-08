import { Agent, CursorAgentError } from "@cursor/sdk";

export type SdkEventHandler = (event: unknown) => void;
export type TextDeltaHandler = (text: string) => void;

export interface AgentSessionOptions {
  apiKey: string;
  model: string;
  cwd: string;
}

export class AgentStartupError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "AgentStartupError";
    this.retryable = retryable;
  }
}

type SdkAgent = Awaited<ReturnType<typeof Agent.create>>;
type SdkRun = Awaited<ReturnType<SdkAgent["send"]>>;

export class AgentSession {
  private agent: SdkAgent | undefined;
  private currentRun: SdkRun | undefined;
  private options: AgentSessionOptions | undefined;
  private creating: Promise<SdkAgent> | undefined;

  get busy(): boolean {
    return Boolean(this.currentRun);
  }

  async ensure(options: AgentSessionOptions): Promise<void> {
    const same =
      this.agent &&
      this.options &&
      this.options.apiKey === options.apiKey &&
      this.options.model === options.model &&
      this.options.cwd === options.cwd;
    if (same) {
      return;
    }
    await this.dispose();
    this.options = options;
    await this.getAgent();
  }

  async send(prompt: string, handlers: { onEvent: SdkEventHandler; onDelta: TextDeltaHandler }): Promise<{
    status: "finished" | "error" | "cancelled";
    result?: string;
    errorMessage?: string;
  }> {
    if (this.currentRun) {
      throw new Error("当前已有任务在执行，请先等待完成或取消。");
    }

    const agent = await this.getAgent();
    let streamed = "";
    const pushText = (chunk: string) => {
      if (!chunk) {
        return;
      }
      streamed += chunk;
      handlers.onDelta(chunk);
    };

    let run: SdkRun;
    try {
      run = await agent.send(prompt, {
        onDelta: (args) => {
          const update = args && typeof args === "object" && "update" in args ? args.update : args;
          if (update && typeof update === "object" && "type" in update && update.type === "text-delta" && "text" in update && typeof update.text === "string") {
            pushText(update.text);
          }
        },
      });
    } catch (error) {
      throw this.wrapStartup(error);
    }

    this.currentRun = run;
    try {
      for await (const event of run.stream()) {
        const text = extractAssistantText(event);
        if (text.startsWith(streamed) && text.length > streamed.length) {
          pushText(text.slice(streamed.length));
        }
        handlers.onEvent(event);
      }
      const result = await run.wait();
      if (result.status === "error") {
        return {
          status: "error",
          result: result.result,
          errorMessage: result.error?.message ?? "任务执行失败",
        };
      }
      if (result.status === "cancelled") {
        return { status: "cancelled", result: result.result };
      }
      return { status: "finished", result: result.result };
    } finally {
      this.currentRun = undefined;
    }
  }

  async cancel(): Promise<void> {
    const run = this.currentRun;
    if (!run) {
      return;
    }
    try {
      if (run.supports("cancel")) {
        await run.cancel();
      }
    } catch {
      // 取消失败时仍清理引用，避免卡死发送
    }
  }

  async dispose(): Promise<void> {
    await this.cancel();
    const agent = this.agent;
    this.agent = undefined;
    this.options = undefined;
    this.creating = undefined;
    this.currentRun = undefined;
    if (!agent) {
      return;
    }
    try {
      await agent[Symbol.asyncDispose]();
    } catch {
      // 忽略销毁错误
    }
  }

  private async getAgent(): Promise<SdkAgent> {
    if (this.agent) {
      return this.agent;
    }
    if (!this.options) {
      throw new AgentStartupError("尚未配置 Agent 会话", false);
    }
    if (!this.creating) {
      const { apiKey, model, cwd } = this.options;
      this.creating = Agent.create({
        apiKey,
        model: { id: model },
        local: { cwd },
      })
        .then((agent) => {
          this.agent = agent;
          return agent;
        })
        .catch((error) => {
          this.creating = undefined;
          throw this.wrapStartup(error);
        });
    }
    return this.creating;
  }

  private wrapStartup(error: unknown): AgentStartupError {
    if (error instanceof CursorAgentError) {
      return new AgentStartupError(error.message || "无法启动 Cursor Agent", Boolean(error.isRetryable));
    }
    if (error instanceof AgentStartupError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new AgentStartupError(message || "无法启动 Cursor Agent", false);
  }
}

function extractAssistantText(event: unknown): string {
  if (!event || typeof event !== "object" || !("type" in event) || event.type !== "assistant") {
    return "";
  }
  const message = "message" in event ? event.message : undefined;
  const content = message && typeof message === "object" && "content" in message ? message.content : undefined;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return Boolean(block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string");
    })
    .map((block) => block.text)
    .join("");
}
