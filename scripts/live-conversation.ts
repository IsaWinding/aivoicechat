import { mkdirSync, writeFileSync } from 'node:fs';
import { AgentSession } from '../src/agentSession';
import { replyForSpeech } from '../src/progress';

const session = new AgentSession();
const results: Record<string, unknown>[] = [];
const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) throw new Error('CURSOR_API_KEY is required');
const watchdog = setTimeout(() => {
  console.error('Live conversation test timed out');
  process.exitCode = 1;
  void session.dispose();
}, 120_000);

async function ask(name: string, prompt: string, interrupt = false) {
  const started = performance.now();
  let firstTextMs: number | undefined;
  let cancelAt: number | undefined;
  let cancelAckMs: number | undefined;
  let cancelPromise: Promise<void> | undefined;
  const outcome = await session.send(`这是只读语音对话测试。不要使用任何工具，不读写文件、不运行命令。${prompt}`, {
    onEvent() {},
    onDelta(chunk) {
      if (!chunk.trim()) return;
      firstTextMs ??= Math.round(performance.now() - started);
      if (interrupt && cancelAt === undefined) {
        cancelAt = performance.now();
        cancelPromise = session.cancel().then(() => { cancelAckMs = Math.round(performance.now() - cancelAt!); });
      }
    },
  });
  await cancelPromise;
  const row = { name, status: outcome.status, firstTextMs,
    totalMs: Math.round(performance.now() - started), cancelAckMs,
    cancelToTerminalMs: cancelAt === undefined ? undefined : Math.round(performance.now() - cancelAt),
    text: outcome.result || '', speech: replyForSpeech(outcome.result || ''),
    error: outcome.errorMessage,
  };
  results.push(row);
  console.log(JSON.stringify(row));
  if (outcome.status === 'error') throw new Error(outcome.errorMessage);
  return row;
}

async function main() {
try {
  await session.ensure({ apiKey, model: 'composer-2.5', cwd: process.cwd() });
  const summary = await ask('summary-and-code', '假设一个应用的发送按钮会重复提交。先口头概括修复思路，再给一小段 JavaScript 示例和 npm test 命令。假设还没有真机验证，必须说明。');
  if (summary.speech.length > 180 || /npm test|const |```/.test(summary.speech)) throw new Error('Speech leaked code or exceeded budget');
  await ask('context-initial', '接下来讨论一个虚构应用：我原本想要红色的发送按钮。记住这个偏好，用一句话确认。');
  const correction = await ask('context-correction', '改一下，刚才的颜色不要了，用蓝色，其他不变。请明确最终颜色。');
  if (!correction.text.includes('蓝')) throw new Error('Latest correction was not followed');
  const cancelled = await ask('interrupt-generation', '现在详细解释十种聊天交互设计，每种至少三句话。', true);
  if (cancelled.status !== 'cancelled') throw new Error('Run did not report cancelled');
  const resumed = await ask('resume-after-interruption', '先停下刚才的长解释，只用一句话告诉我：发送按钮最后应该是什么颜色？');
  if (!resumed.text.includes('蓝')) throw new Error('Conversation context was lost after interruption');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await session.dispose();
  mkdirSync('out', { recursive: true });
  writeFileSync('out/live-conversation-results.json', JSON.stringify({ recordedAt: new Date().toISOString(), model: 'composer-2.5', results }, null, 2));
}

}
void main();
