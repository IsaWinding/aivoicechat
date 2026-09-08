import * as http from "node:http";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

/**
 * 浏览器麦克风桥。
 * Cursor 的 Webview 禁止访问麦克风，因此在本机开一个只监听 127.0.0.1 的小服务，
 * 用系统浏览器（Edge/Chrome）打开识别页面：浏览器会正常弹出麦克风授权，
 * 识别到的文字通过 POST 回传给扩展；扩展的状态通过 SSE 推给页面。
 */
export interface MicBridgeEvent {
  kind: "status" | "progress" | "assistant" | "error" | "hello" | "speak" | "mute" | "unmute" | "settings" | "stopSpeech";
  text: string;
  state?: string;
  autoSpeak?: boolean;
}

export class MicBridge {
  private server: http.Server | undefined;
  private port = 0;
  private readonly token = randomBytes(12).toString("hex");
  private readonly clients = new Set<http.ServerResponse>();
  private lastEvents: MicBridgeEvent[] = [];
  private readonly transcriptIds = new Set<string>();

  constructor(
    private readonly mediaDir: string,
    private readonly handlers: {
      onTranscript: (text: string) => void;
      onInterrupt?: () => void;
      onListening: (listening: boolean) => void;
      onTestSpeak?: () => void;
      /** 页面上的喇叭按钮：同步到 Cursor 的 autoSpeak 设置 */
      onAutoSpeak?: (enabled: boolean) => void;
      /** 页面刚连上时需要下发的初始状态（如当前 autoSpeak） */
      initialEvents?: () => MicBridgeEvent[];
    },
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/?t=${this.token}`;
  }

  get running(): boolean {
    return Boolean(this.server);
  }

  get hasClients(): boolean {
    return this.clients.size > 0;
  }

  async start(): Promise<string> {
    if (this.server) {
      return this.url;
    }
    const server = http.createServer((req, res) => this.route(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.url;
  }

  broadcast(event: MicBridgeEvent): void {
    if (event.kind !== "stopSpeech" && event.kind !== "speak" && event.kind !== "mute" && event.kind !== "unmute" && event.kind !== "settings") {
      this.lastEvents.push(event);
    }
    if (this.lastEvents.length > 30) {
      this.lastEvents.shift();
    }
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  dispose(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("t") !== this.token) {
      res.writeHead(403).end("forbidden");
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      const file = path.join(this.mediaDir, "mic.html");
      let html: string;
      try {
        html = fs.readFileSync(file, "utf8");
      } catch {
        res.writeHead(500).end("mic.html missing");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html.replace("__TOKEN__", this.token));
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello", text: "已连接 Cursor" } satisfies MicBridgeEvent)}\n\n`);
      for (const event of [...(this.handlers.initialEvents?.() ?? []), ...this.lastEvents.slice(-8)]) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/interrupt") {
      this.handlers.onInterrupt?.();
      res.writeHead(204).end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/test-speak") {
      this.handlers.onTestSpeak?.();
      res.writeHead(204).end();
      return;
    }

    if (req.method === "POST" && (url.pathname === "/transcript" || url.pathname === "/state" || url.pathname === "/auto-speak")) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64_000) {
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          const data = JSON.parse(body || "{}") as { text?: string; id?: string; listening?: boolean; enabled?: boolean };
          if (url.pathname === "/transcript" && typeof data.text === "string" && data.text.trim()) {
            const id = typeof data.id === "string" ? data.id : undefined;
            if (!id || !this.transcriptIds.has(id)) {
              this.handlers.onTranscript(data.text.trim());
              if (id) {
                this.transcriptIds.add(id);
                if (this.transcriptIds.size > 256) this.transcriptIds.delete(this.transcriptIds.values().next().value!);
              }
            }
          }
          if (url.pathname === "/state" && typeof data.listening === "boolean") {
            this.handlers.onListening(data.listening);
          }
          if (url.pathname === "/auto-speak" && typeof data.enabled === "boolean") {
            this.handlers.onAutoSpeak?.(data.enabled);
          }
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end("bad json");
        }
      });
      return;
    }

    res.writeHead(404).end("not found");
  }
}
