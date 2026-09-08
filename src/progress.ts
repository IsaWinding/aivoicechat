export interface ProgressNotice {
  text: string;
  speak: boolean;
  speakText?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function extractPath(args: unknown): string | undefined {
  const record = asRecord(args);
  const nested = record ? asRecord(record.input) ?? asRecord(record.params) ?? asRecord(record.arguments) : undefined;
  return (
    firstString(record, ["path", "file", "filePath", "target_file", "targetFile", "filename", "command"]) ??
    firstString(nested, ["path", "file", "filePath", "target_file", "targetFile", "filename", "command"])
  );
}

function shortPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return normalized;
  }
  return parts.slice(-2).join("/");
}

function toolLabel(name: string): { verbStart: string; verbDone: string; kind: "read" | "edit" | "shell" | "search" | "other" } {
  const lower = name.toLowerCase();
  if (/(read|readfile|read_file)/.test(lower)) {
    return { verbStart: "正在阅读", verbDone: "已阅读", kind: "read" };
  }
  if (/(write|edit|strreplace|search_replace|applypatch|delete)/.test(lower)) {
    return { verbStart: "正在修改", verbDone: "已修改", kind: "edit" };
  }
  if (/(shell|bash|terminal|command)/.test(lower)) {
    return { verbStart: "正在执行命令", verbDone: "命令已完成", kind: "shell" };
  }
  if (/(grep|glob|rg|search|semsearch)/.test(lower)) {
    return { verbStart: "正在搜索", verbDone: "搜索完成", kind: "search" };
  }
  return { verbStart: `正在使用 ${name}`, verbDone: `${name} 已完成`, kind: "other" };
}

/** 把 Markdown 回答转成适合朗读的纯文本：去掉代码块、符号、链接，限制长度。 */
export function toSpeechText(text: string, maxChars = 600): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~>|#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  const cut = cleaned.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("."));
  return `${lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut}，详细内容请看文字。`;
}

export function summarizeForSpeech(text: string, maxChars = 120): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  const sentence = cleaned.split(/(?<=[。！？!?])/).find((part) => part.trim());
  const source = (sentence ?? cleaned).trim();
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, maxChars)}…`;
}

export function interpretSdkEvent(event: unknown): ProgressNotice | null {
  const record = asRecord(event);
  if (!record || typeof record.type !== "string") {
    return null;
  }

  if (record.type === "tool_call") {
    const name = typeof record.name === "string" ? record.name : "工具";
    const status = typeof record.status === "string" ? record.status : "";
    const label = toolLabel(name);
    const target = extractPath(record.args);
    const targetText = target ? ` ${shortPath(target)}` : "";

    if (status === "running") {
      const text = `${label.verbStart}${targetText}`;
      return { text, speak: label.kind !== "read", speakText: text };
    }
    if (status === "error") {
      const text = `${name} 失败${targetText}`;
      return { text, speak: true, speakText: text };
    }
    if (status === "completed" && label.kind === "edit") {
      return { text: `${label.verbDone}${targetText}`, speak: false };
    }
    return null;
  }

  if (record.type === "task") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) {
      return null;
    }
    return { text, speak: true, speakText: summarizeForSpeech(text, 80) };
  }

  if (record.type === "status") {
    const status = typeof record.status === "string" ? record.status : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (status === "ERROR") {
      return { text: message || "任务出错", speak: true, speakText: message || "任务出错" };
    }
    return null;
  }

  return null;
}
