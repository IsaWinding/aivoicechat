import * as vscode from "vscode";
import { AgentSession, AgentStartupError } from "./agentSession";
import { MicBridge } from "./micBridge";
import { immediateAck, interpretSdkEvent, toSpeechText } from "./progress";
import { SpokenReplyComposer, type SpokenHistoryItem } from "./spokenReply";
import { SystemSpeaker } from "./systemTts";
import type { ChatTranscriptItem, HostSettings, HostState, HostToWebview, WebviewToHost } from "./protocol";

const WELCOME =
  "你好，我是 Cursor 语音助手。用语音或文字告诉我要做什么，我会在当前工作区执行，并用文字和语音回报进度。";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "aivoicechat.chatView";
  public static readonly explorerViewId = "aivoicechat.explorerView";

  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private readonly webviews = new Set<vscode.Webview>();
  private messages: ChatTranscriptItem[] = [];
  private readonly session = new AgentSession();
  private readonly spokenReply = new SpokenReplyComposer();
  private spokenHistory: SpokenHistoryItem[] = [];
  private speechVersion = 0;
  private state: HostState = "idle";
  private lastSpeakAt = 0;
  private bridge: MicBridge | undefined;
  private readonly systemSpeaker = new SystemSpeaker();
  private queuedVoice: string[] = [];
  private active = false;
  private turnDone: Promise<void> = Promise.resolve();
  private finishTurn: (() => void) | undefined;
  private interrupted = false;
  private waitingForUser = false;
  private resetting = false;

  constructor(private readonly extensionUri: vscode.Uri) {
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("aivoicechat")) {
        this.syncSettings();
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.attach(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.webviews.delete(webviewView.webview);
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  async dispose(): Promise<void> {
    this.resetting = true;
    this.interrupted = true;
    this.queuedVoice = [];
    this.stopSpeech();
    this.bridge?.dispose();
    await this.session.dispose();
  }

  toggleMic(): void {
    const mode = vscode.workspace.getConfiguration("aivoicechat").get<string>("speechInput") || "browser";
    if (mode === "webview") {
      this.post({ type: this.state === "listening" ? "stopListening" : "startListening" });
      return;
    }
    void this.openMicBridge();
  }

  /** 在系统浏览器里打开语音识别页；浏览器会弹出麦克风授权。 */
  async openMicBridge(): Promise<void> {
    if (!this.bridge) {
      this.bridge = new MicBridge(vscode.Uri.joinPath(this.extensionUri, "media").fsPath, {
        onTranscript: (text) => this.onVoiceText(text),
        onInterrupt: () => { void this.interrupt(); },
        onTestSpeak: () => this.testSpeak(true),
        onAutoSpeak: (enabled) => void this.setAutoSpeak(enabled),
        initialEvents: () => [this.settingsEvent()],
        onListening: (listening) => {
          if (listening && this.state === "idle") {
            this.setState("listening", "浏览器聆听中");
          } else if (!listening && this.state === "listening") {
            this.setState("idle", "准备就绪");
          }
        },
      });
    }
    try {
      const url = await this.bridge.start();
      await vscode.env.openExternal(vscode.Uri.parse(url));
      this.pushProgress("已在浏览器打开语音输入页，请允许麦克风后直接说话。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.post({ type: "error", message: `无法启动语音页面：${message}` });
    }
  }

  private onVoiceText(text: string): void {
    void this.handleSend(text);
  }

  private stopSpeech(): void {
    this.speechVersion++;
    this.spokenReply.cancel();
    this.systemSpeaker.cancel();
    this.post({ type: "stopSpeech" });
    this.bridge?.broadcast({ kind: "stopSpeech", text: "" });
  }

  private async interrupt(waitForUser = true): Promise<void> {
    this.interrupted = true;
    this.waitingForUser = waitForUser;
    const lastSpoken = this.spokenHistory.at(-1);
    if (lastSpoken) lastSpoken.delivery = "interrupted";
    this.stopSpeech();
    this.setState("listening", "正在听你说…");
    await this.session.cancel();
  }

  /** 语音播报开关是全局设置；面板、浏览器页、命令三处共用，改动后同步到所有界面。 */
  private async setAutoSpeak(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration("aivoicechat").update("autoSpeak", enabled, vscode.ConfigurationTarget.Global);
    if (!enabled) {
      this.stopSpeech();
    }
    this.pushProgress(enabled ? "语音播报已开启" : "语音播报已关闭（Cursor 的回答不再朗读，点喇叭按钮可重新开启）");
    this.syncSettings();
  }

  private syncSettings(): void {
    if (!this.readSettings().autoSpeak) this.stopSpeech();
    this.post({ type: "settings", settings: this.readSettings() });
    this.bridge?.broadcast(this.settingsEvent());
  }

  private settingsEvent() {
    return { kind: "settings" as const, text: "", autoSpeak: this.readSettings().autoSpeak };
  }

  private flushQueuedVoice(): void {
    if (this.resetting || this.active || this.waitingForUser) return;
    const next = this.queuedVoice.splice(0).join("\n");
    if (next) void this.handleSend(next);
  }

  async newSession(): Promise<void> {
    this.resetting = true;
    this.queuedVoice = [];
    await this.interrupt();
    await this.turnDone;
    await this.session.dispose();
    this.messages = [];
    this.spokenHistory = [];
    this.setState("idle", "准备就绪");
    this.post({ type: "sessionReset", settings: this.readSettings() });
    this.resetting = false;
  }

  async cancel(): Promise<void> {
    this.queuedVoice = [];
    await this.interrupt();
    this.setState("idle", "已停止");
  }

  testSpeak(fromUi = false): void {
    this.stopSpeech();
    if (!fromUi) {
      this.open();
      void vscode.window.showInformationMessage("正在试播，请注意听耳机或扬声器。");
    }
    const output = this.resolveSpeechOutput();
    const via = output === "system" ? "系统语音" : output === "browser" ? "浏览器" : "面板";
    this.pushProgress(`正在试听（${via}），请注意听耳机或扬声器…`);
    this.speakNow("语音测试正常。如果你听到了这句话，说明耳机和播报功能都没问题。", true);
  }

  open(): void {
    this.openEditorPanel();
  }

  closePanel(): void {
    this.panel?.dispose();
  }

  private openEditorPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "aivoicechat.editor",
      "AI 语音聊天",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");
    this.attach(panel.webview);
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview);
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
  }

  private attach(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = this.renderHtml(webview);
    webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.onMessage(message);
    });
    this.webviews.add(webview);
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case "ready":
        this.post({ type: "init", settings: this.readSettings(), messages: this.messages });
        return;
      case "send":
        await this.handleSend(message.text);
        return;
      case "interrupt":
        await this.interrupt();
        return;
      case "cancel":
        await this.cancel();
        return;
      case "newSession":
        await this.newSession();
        return;
      case "setAutoSpeak":
        await this.setAutoSpeak(message.enabled);
        return;
      case "toggleMic":
        this.toggleMic();
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "aivoicechat");
        return;
      case "testSpeak":
        this.testSpeak(true);
        return;
      case "close":
        this.closePanel();
        return;
    }
  }

  private async handleSend(raw: string): Promise<void> {
    let text = raw.trim();
    if (!text) {
      return;
    }
    if (this.resetting) return;
    this.waitingForUser = false;
    this.stopSpeech();
    if (this.active) {
      this.queuedVoice.push(text);
      await this.interrupt(false);
      return;
    }
    if (this.queuedVoice.length) text = [...this.queuedVoice.splice(0), text].join("\n");

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      this.post({ type: "error", message: "请先在 Cursor 中打开一个工作区文件夹。" });
      return;
    }

    const apiKey = this.readApiKey();
    if (!apiKey) {
      this.post({
        type: "error",
        message: "尚未配置 Cursor API Key。请在设置 aivoicechat.apiKey 中填写，或设置环境变量 CURSOR_API_KEY。",
      });
      return;
    }

    this.active = true;
    this.turnDone = new Promise(resolve => { this.finishTurn = resolve; });
    this.interrupted = false;
    const userId = this.id("user");
    this.push({ id: userId, role: "user", text, done: true });
    this.post({ type: "userMessage", id: userId, text });

    const assistantId = this.id("assistant");
    this.push({ id: assistantId, role: "assistant", text: "", done: false });
    this.post({ type: "assistantStart", id: assistantId });
    this.setState("running", "执行中");
    this.speakImmediateAck(text);

    const model = vscode.workspace.getConfiguration("aivoicechat").get<string>("model") || "composer-2.5";
    let streamed = "";
    const importantEvents: string[] = [];

    try {
      await this.session.ensure({
        apiKey,
        model,
        cwd: folders[0].uri.fsPath,
      });

      if (this.interrupted || this.resetting) return;
      const outcome = await this.session.send(text, {
        onDelta: (chunk) => {
          if (this.interrupted || this.resetting) return;
          streamed += chunk;
          this.updateAssistant(assistantId, streamed);
          this.post({ type: "assistantDelta", id: assistantId, text: chunk });
        },
        onEvent: (event) => {
          if (this.interrupted || this.resetting) return;
          const notice = interpretSdkEvent(event);
          if (!notice) {
            return;
          }
          this.pushProgress(notice.text);
          if (notice.speak) {
            importantEvents.push(notice.text);
          }
        },
      });

      if (this.interrupted || this.resetting) return;
      // Some SDK/runtime versions return an empty terminal result even though
      // assistant text was received from the stream. Never erase that text.
      const finalText = outcome.result?.trim() || streamed.trim();
      this.updateAssistant(assistantId, finalText, true);
      this.post({ type: "assistantDone", id: assistantId, text: finalText });
      if (finalText) {
        this.bridge?.broadcast({ kind: "assistant", text: finalText });
      }

      if (outcome.status === "cancelled") {
        this.pushProgress("任务已取消");
        this.maybeSpeak("任务已取消", true);
      } else if (outcome.status === "error") {
        const message = outcome.errorMessage ?? "任务执行失败";
        this.post({ type: "error", message });
        importantEvents.push(message);
        await this.composeAndSpeak(text, finalText, "error", importantEvents, assistantId);
      } else {
        await this.composeAndSpeak(text, finalText, "finished", importantEvents, assistantId);
      }
    } catch (error) {
      if (this.interrupted || this.resetting) return;
      this.updateAssistant(assistantId, streamed, true);
      this.post({ type: "assistantDone", id: assistantId });
      const message =
        error instanceof AgentStartupError
          ? `无法启动 Agent：${error.message}${error.retryable ? "（可重试）" : ""}。请检查 API Key 和网络。`
          : error instanceof Error
            ? error.message
            : String(error);
      this.post({ type: "error", message });
      this.maybeSpeak("这次处理没有完成，具体原因请查看文字提示。", true);
    } finally {
      this.updateAssistant(assistantId, this.messages.find(item => item.id === assistantId)?.text || "", true);
      this.post({ type: "assistantDone", id: assistantId });
      this.active = false;
      this.finishTurn?.();
      this.finishTurn = undefined;
      if (!this.interrupted && !this.resetting && !this.systemSpeaker.speaking) this.setState("idle", "准备就绪");
      this.flushQueuedVoice();
    }
  }

  private async composeAndSpeak(question: string, fullResult: string, status: "finished" | "error", importantEvents: string[], assistantId: string): Promise<void> {
    if (!this.readSettings().autoSpeak || this.interrupted || this.resetting) return;
    const version = this.speechVersion;
    this.setState("running", "正在整理口语回答…");
    const reply = await this.spokenReply.compose({
      apiKey: this.readApiKey(),
      model: vscode.workspace.getConfiguration("aivoicechat").get<string>("model") || "composer-2.5",
      cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
    }, {
      latestQuestion: question,
      fullResult,
      status,
      importantEvents,
      language: this.readSettings().language,
      recentConversation: this.messages.filter((item): item is ChatTranscriptItem & { role: "user" | "assistant" } =>
        item.role !== "progress" && item.id !== assistantId).slice(-8).map(({ role, text }) => ({ role, text })),
      previousReplies: this.spokenHistory.map(item => ({ ...item })),
    });
    if (!reply || version !== this.speechVersion || this.interrupted || this.resetting || !this.readSettings().autoSpeak) return;
    // Keep the spoken version visible without replacing the complete answer.
    this.pushProgress(`${reply.fallback ? "语音提示" : "口语回答"}：${reply.text}`);
    this.spokenHistory.push({ text: reply.text, delivery: "requested" });
    this.spokenHistory = this.spokenHistory.slice(-6);
    this.maybeSpeak(reply.text, true);
  }

  private readSettings(): HostSettings {
    const config = vscode.workspace.getConfiguration("aivoicechat");
    return {
      language: config.get<string>("language") || "zh-CN",
      autoSpeak: config.get<boolean>("autoSpeak") !== false,
      speechInput: config.get<string>("speechInput") === "webview" ? "webview" : "browser",
      hasApiKey: Boolean(this.readApiKey()),
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
    };
  }

  private readApiKey(): string {
    const configured = vscode.workspace.getConfiguration("aivoicechat").get<string>("apiKey")?.trim();
    return configured || process.env.CURSOR_API_KEY?.trim() || "";
  }

  private setState(state: HostState, label: string): void {
    this.state = state;
    this.post({ type: "status", state, label });
    void vscode.commands.executeCommand("setContext", "aivoicechat.running", state === "running");
  }

  private push(item: ChatTranscriptItem): void {
    this.messages.push(item);
  }

  private updateAssistant(id: string, text: string, done = false): void {
    const item = this.messages.find((message) => message.id === id);
    if (item) {
      item.text = text;
      item.done = done;
    }
  }

  private pushProgress(text: string): void {
    const id = this.id("progress");
    this.push({ id, role: "progress", text, done: true });
    this.post({ type: "progress", id, text });
  }

  private speakImmediateAck(question: string): void {
    if (!this.readSettings().autoSpeak || this.interrupted || this.resetting) {
      return;
    }
    const text = immediateAck(question);
    this.pushProgress(`已确认：${text}`);
    this.spokenHistory.push({ text, delivery: "requested" });
    this.spokenHistory = this.spokenHistory.slice(-6);
    this.maybeSpeak(text, true);
  }

  private maybeSpeak(text: string, force = false): void {
    if (this.interrupted) return;
    const cleaned = toSpeechText(text, 240);
    if (!cleaned) {
      return;
    }
    const autoSpeak = vscode.workspace.getConfiguration("aivoicechat").get<boolean>("autoSpeak") !== false;
    if (!autoSpeak) {
      if (force) {
        // 回答完成却不出声时，明确告诉用户是开关关了，而不是耳机坏了
        this.pushProgress("语音播报处于关闭状态，未朗读本条回答。点喇叭按钮可开启。");
      }
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastSpeakAt < 1600 && this.state === "running") {
      return;
    }
    this.lastSpeakAt = now;
    this.speakNow(cleaned);
  }

  private resolveSpeechOutput(): "system" | "browser" | "webview" {
    let output = vscode.workspace.getConfiguration("aivoicechat").get<string>("speechOutput") || "auto";
    if (output === "auto") {
      return SystemSpeaker.supported ? "system" : this.bridge?.hasClients ? "browser" : "webview";
    }
    if (output === "system" && SystemSpeaker.supported) {
      return "system";
    }
    if (output === "browser" && this.bridge?.hasClients) {
      return "browser";
    }
    return "webview";
  }

  private speakViaSystem(text: string): void {
    this.setState("speaking", "播报中，可随时插话");
    this.bridge?.broadcast({ kind: "mute", text: "正在播报…" });
    this.systemSpeaker.speak(text, () => {
      this.bridge?.broadcast({ kind: "unmute", text: "" });
      if (!this.active && !this.interrupted) {
        this.setState("idle", "准备就绪");
      }
    });
  }

  private speakNow(text: string, test = false): void {
    const output = this.resolveSpeechOutput();
    if (output === "system") {
      this.speakViaSystem(text);
      return;
    }
    if (output === "browser") {
      this.bridge?.broadcast({ kind: "speak", text });
      return;
    }
    this.post({ type: "speak", text, test });
  }

  private post(message: HostToWebview): void {
    for (const webview of this.webviews) {
      void webview.postMessage(message);
    }
    if (!this.bridge?.running) {
      return;
    }
    if (message.type === "status") {
      this.bridge.broadcast({ kind: "status", text: message.label, state: message.state });
    } else if (message.type === "progress") {
      this.bridge.broadcast({ kind: "progress", text: message.text });
    } else if (message.type === "error") {
      this.bridge.broadcast({ kind: "error", text: message.message });
    }
  }

  private id(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"));
    const voice = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "voice.js"));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const iconMic =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg>';
    const iconClose =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 7l10 10M17 7L7 17"/></svg>';
    const iconDown =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 9l6 6 6-6"/></svg>';
    const iconSpeak =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10v4h4l5 4V6L8 10H4z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>';
    const iconHeadset =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${style}" />
  <title>AI 语音聊天</title>
</head>
<body class="hud">
  <div class="stage">
    <div class="status-card" id="statusCard">
      <div class="status-copy">
        <div class="status-title" id="statusTitle">新对话</div>
        <div class="status-sub" id="statusSub">准备就绪</div>
      </div>
      <div class="status-icon idle" id="statusIcon"></div>
    </div>

    <button type="button" class="orb idle" id="orbBtn" title="点击开始说话"></button>
    <div class="hint" id="hint">点击光球开始说话</div>

    <div class="round-bar">
      <button type="button" class="round" id="micBtn" title="语音">${iconMic}</button>
      <button type="button" class="round" id="cancelBtn" title="关闭">${iconClose}</button>
      <button type="button" class="round" id="expandBtn" title="展开对话">${iconDown}</button>
      <button type="button" class="round" id="speakToggle" title="语音播报" aria-pressed="true">${iconSpeak}</button>
      <button type="button" class="round" id="testBtn" title="试听语音（检查耳机）">${iconHeadset}</button>
    </div>

    <section class="sheet hidden" id="sheet">
      <div class="banner hidden" id="keyBanner">
        尚未配置 API Key。
        <button type="button" id="openSettings">打开设置</button>
      </div>
      <div class="sheet-head">
        <span id="workspace">未打开工作区</span>
        <button type="button" class="text-btn" id="newSession">新会话</button>
      </div>
      <main class="timeline" id="timeline"></main>
      <footer class="composer">
        <textarea id="input" rows="2" placeholder="输入消息，回车发送，Shift+Enter 换行"></textarea>
        <button type="button" class="send" id="sendBtn">发送</button>
      </footer>
    </section>
  </div>
  <script nonce="${nonce}">window.__WELCOME__ = ${JSON.stringify(WELCOME)};</script>
  <script nonce="${nonce}" src="${voice}"></script>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
