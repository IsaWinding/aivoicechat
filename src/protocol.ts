export type HostState = "idle" | "listening" | "running" | "speaking";

export interface ChatTranscriptItem {
  id: string;
  role: "user" | "assistant" | "progress";
  text: string;
  done?: boolean;
}

export interface HostSettings {
  language: string;
  autoSpeak: boolean;
  speechInput: "browser" | "webview";
  hasApiKey: boolean;
  workspaceName?: string;
}

export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "interrupt" }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "setAutoSpeak"; enabled: boolean }
  | { type: "toggleMic" }
  | { type: "openSettings" }
  | { type: "testSpeak" }
  | { type: "close" };

export type HostToWebview =
  | { type: "init"; settings: HostSettings; messages: ChatTranscriptItem[] }
  | { type: "userMessage"; id: string; text: string }
  | { type: "assistantStart"; id: string }
  | { type: "assistantDelta"; id: string; text: string }
  | { type: "assistantDone"; id: string; text?: string }
  | { type: "progress"; id: string; text: string }
  | { type: "status"; state: HostState; label: string }
  | { type: "speak"; text: string; test?: boolean }
  | { type: "error"; message: string }
  | { type: "sessionReset"; settings: HostSettings }
  | { type: "settings"; settings: HostSettings }
  | { type: "startListening" }
  | { type: "stopSpeech" }
  | { type: "stopListening" };
