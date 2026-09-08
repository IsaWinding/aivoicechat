import { spawn, type ChildProcess } from "node:child_process";

/**
 * Windows 系统语音（SAPI / System.Speech）。
 * 不经过浏览器和 Webview，不受自动播放策略限制。
 * 文本通过 stdin 传入，避免命令行引号/编码问题。
 */
const SCRIPT = [
  "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$t = [Console]::In.ReadToEnd()",
  "$v = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -like 'zh*' } | Select-Object -First 1",
  "if ($v) { $s.SelectVoice($v.Name) }",
  "$s.Rate = 1",
  "$s.Speak($t)",
].join("; ");

export class SystemSpeaker {
  private current: ChildProcess | undefined;

  static get supported(): boolean {
    return process.platform === "win32";
  }

  speak(text: string, onDone?: () => void): void {
    this.cancel();
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    this.current = proc;
    // 只有「自然结束」才回调 onDone；被新一条播报打断（cancel）的不回调，
    // 否则会在新一条还在朗读时就通知浏览器恢复识别，录到自己的声音。
    const finish = () => {
      if (this.current !== proc) {
        return;
      }
      this.current = undefined;
      onDone?.();
    };
    proc.on("exit", finish);
    proc.on("error", finish);
    proc.stdin?.on("error", () => {
      // 进程启动失败时 stdin 写入会报 EPIPE，忽略
    });
    proc.stdin?.end(text, "utf8");
  }

  cancel(): void {
    const proc = this.current;
    this.current = undefined;
    if (proc && !proc.killed) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }

  get speaking(): boolean {
    return Boolean(this.current);
  }
}
