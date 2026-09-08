/**
 * 语音识别 / 播报契约。
 * Webview 里的 Web Speech 实现遵循同一接口；
 * 后续云端 Whisper / Azure 只需新增实现，不必改聊天主流程。
 */
export interface SpeechToTextOptions {
  language: string;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

export interface SpeechToText {
  readonly engine: "webspeech" | "cloud";
  start(options: SpeechToTextOptions): void;
  stop(): void;
}

export interface TextToSpeechOptions {
  language: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

export interface TextToSpeech {
  readonly engine: "webspeech" | "cloud";
  enabled: boolean;
  speak(text: string, options?: TextToSpeechOptions): void;
  cancel(): void;
}

/** 预留：云端引擎标识。实现见 CloudSpeechProvider。 */
export type CloudSpeechEngine = "whisper" | "azure" | "aliyun";

export interface CloudSpeechConfig {
  engine: CloudSpeechEngine;
  apiKey: string;
  endpoint?: string;
  language: string;
}
