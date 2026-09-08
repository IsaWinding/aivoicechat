import type { CloudSpeechConfig, SpeechToText, SpeechToTextOptions, TextToSpeech, TextToSpeechOptions } from "./types";

/**
 * 云端 STT/TTS 占位。第一版不接入，仅保留扩展点。
 * 后续可在扩展宿主侧录音后调用 Whisper / Azure / 阿里，再把结果发回 Webview。
 */
export class CloudSpeechProvider implements SpeechToText, TextToSpeech {
  readonly engine = "cloud" as const;
  enabled = false;

  constructor(private readonly _config: CloudSpeechConfig) {}

  start(_options: SpeechToTextOptions): void {
    throw new Error("云端语音尚未实现，请使用 Web Speech，或在设置中关闭云端引擎。");
  }

  speak(_text: string, _options?: TextToSpeechOptions): void {
    throw new Error("云端语音尚未实现。");
  }

  stop(): void {}
  cancel(): void {}
}
