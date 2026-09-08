type SdkModule = typeof import("@cursor/sdk");
type SdkAgent = Awaited<ReturnType<SdkModule["Agent"]["create"]>>;

function loadSdk(): SdkModule {
  try {
    return require("@cursor/sdk") as SdkModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentStartupError(`无法加载 Cursor SDK（${message}）。请重新安装本扩展。`, false);
  }
}

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

type SdkRun = Awaited<ReturnType<SdkAgent["send"]>>;

export class AgentSession {
  constructor(private readonly purpose: "task" | "speech" = "task") {}
  private agent: SdkAgent | undefined;
  private currentRun: SdkRun | undefined;
  private cancelRequested = false;
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

    this.cancelRequested = false;
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
      const message = this.purpose === "speech" ? prompt : `对话要求：先理解用户最新一句话与上下文，再回答。用户插话或纠正时以最新内容为准，不要继续旧回答。最终回答第一段用 2 到 3 句自然口语概括结论、关键原因和下一步，约 120 字以内；重要失败或未完成事项必须提及。首段用日常语言解释，不包含英文代码标识、命令或路径。没有实际执行验证时不能声称测试通过。随后仅在必要时补充细节、代码和命令。日常聊天自然简短，不要把所有问题都当作执行任务。不要朗读式罗列工具过程。\n\n用户消息：${prompt}`;
      run = await agent.send(message, {
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
    if (this.cancelRequested) await this.cancel();
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
    this.cancelRequested = true;
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
      this.creating = loadSdk().Agent.create({
        apiKey,
        model: { id: model },
        local: this.purpose === "speech" ? { cwd, settingSources: [], enableAgentRetries: false } : { cwd },
        ...(this.purpose === "speech" ? { tools: [], mcpServers: {}, agents: {} } : {}),
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
    if (error instanceof AgentStartupError) {
      return error;
    }
    try {
      const { CursorAgentError } = loadSdk();
      if (error instanceof CursorAgentError) {
        return new AgentStartupError(error.message || "无法启动 Cursor Agent", Boolean(error.isRetryable));
      }
    } catch {
      // SDK 未安装时仍返回原始错误信息
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
