import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['src/chatPanel.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode', '@cursor/sdk'], write: false });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function host() {
  const settings = { apiKey: 'test-only', autoSpeak: true, speechOutput: 'webview' };
  const vscode = { workspace: {
    onDidChangeConfiguration() {}, workspaceFolders: [{ name: 'test', uri: { fsPath: 'test' } }],
    getConfiguration: () => ({ get: key => settings[key] }),
  }, commands: { executeCommand: async () => {} } };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, process, console,
    require: name => name === 'vscode' ? vscode : require(name), setTimeout, clearTimeout,
  });
  const provider = new module.exports.ChatPanelProvider({});
  const compositions = [];
  provider.spokenReply = {
    cancel() {},
    async compose(options, context) { compositions.push(context); return { text: context.fullResult, fallback: false }; },
  };
  const events = []; const runs = []; let cancelCount = 0;
  provider.post = event => events.push(event);
  provider.session = {
    ensure: async () => {},
    send(text, handlers) { const done = deferred(); runs.push({ text, handlers, done }); return done.promise; },
    cancel: async () => { cancelCount++; }, dispose: async () => {},
  };
  return { provider, events, runs, compositions, settings, get cancelCount() { return cancelCount; } };
}

test('interruption suppresses stale deltas and final audio; newest input waits for cancellation', async () => {
  const h = host(); const first = h.provider.handleSend('旧问题'); await settle();
  await h.provider.interrupt();
  await h.provider.handleSend('换个问题');
  assert.equal(h.runs.length, 1);
  h.runs[0].handlers.onDelta('过期回答');
  h.runs[0].done.resolve({ status: 'finished', result: '旧结论' });
  await first; await settle();
  assert.equal(h.runs[1].text, '换个问题');
  assert.ok(!h.events.some(e => e.type === 'speak' && (e.text === '过期回答' || e.text === '旧结论')));
  h.runs[1].done.resolve({ status: 'finished', result: '最新结论。' }); await settle();
  assert.ok(h.events.some(e => e.type === 'speak' && e.text === '最新结论。'));
});

test('consecutive queued corrections merge into one follow-up', async () => {
  const h = host(); const first = h.provider.handleSend('初始任务'); await settle();
  await h.provider.handleSend('改成蓝色'); await h.provider.handleSend('尺寸保持不变');
  h.runs[0].done.resolve({ status: 'cancelled' }); await first; await settle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1].text, '改成蓝色\n尺寸保持不变');
  h.runs[1].done.resolve({ status: 'finished' }); await settle();
});

test('new session drains old run and discards queued messages', async () => {
  const h = host(); const first = h.provider.handleSend('旧任务'); await settle();
  await h.provider.handleSend('旧补充'); const reset = h.provider.newSession();
  h.runs[0].done.resolve({ status: 'cancelled' }); await first; await reset;
  assert.equal(h.runs.length, 1); assert.equal(h.provider.messages.length, 0);
  assert.equal(h.events.at(-1).type, 'sessionReset');
});

test('final text replaces streamed preview in the UI', async () => {
  const h = host(); const first = h.provider.handleSend('问题'); await settle();
  h.runs[0].handlers.onDelta('中间进度');
  h.runs[0].done.resolve({ status: 'finished', result: '最终结论。' }); await first;
  assert.ok(h.events.some(e => e.type === 'assistantDone' && e.text === '最终结论。'));
});

test('a new partial utterance must prevent queued input from starting before user finishes', async () => {
  const h = host(); const first = h.provider.handleSend('初始任务'); await settle();
  await h.provider.handleSend('第一段补充');
  await h.provider.interrupt(); // user starts a second fragment, with no final transcript yet
  h.runs[0].done.resolve({ status: 'cancelled' }); await first; await settle();
  assert.equal(h.runs.length, 1, 'must keep listening until the latest transcript is submitted');
  const second = h.provider.handleSend('第二段补充'); await settle();
  assert.equal(h.runs[1].text, '第一段补充\n第二段补充');
  h.runs[1].done.resolve({ status: 'finished' }); await second;
});

test('immediate acknowledgment speaks before task finishes, then final reply speaks again', async () => {
  const h = host();
  const ack = '好的，收到。我现在开始处理，完成后告诉你结果。';
  const pending = h.provider.handleSend('帮我改一下颜色'); await settle();
  assert.ok(h.events.some(e => e.type === 'speak' && e.text === ack));
  h.runs[0].done.resolve({ status: 'finished', result: '颜色已经改好了。' }); await pending;
  assert.ok(h.events.some(e => e.type === 'speak' && e.text === '颜色已经改好了。'));
  assert.ok(h.events.filter(e => e.type === 'speak').length >= 2);
});

test('speech composer receives full result, user focus, and errors without reading raw tool progress', async () => {
  const h = host(); const pending = h.provider.handleSend('现在可以上线了吗？'); await settle();
  const ack = '好的，收到。我现在开始处理，完成后告诉你结果。';
  h.runs[0].handlers.onEvent({ type: 'tool_call', name: 'Shell', status: 'error', args: { command: 'npm test' } });
  assert.ok(!h.events.some(e => e.type === 'speak' && e.text !== ack));
  h.runs[0].done.resolve({ status: 'finished', result: '开头是进度。\n\n最终验证失败，不能上线。' }); await pending;
  assert.equal(h.compositions[0].latestQuestion, '现在可以上线了吗？');
  assert.match(h.compositions[0].fullResult, /最终验证失败/);
  assert.match(h.compositions[0].importantEvents[0], /失败/);
});

test('interrupt while spoken reply is being composed suppresses late speech', async () => {
  const h = host(); const completion = deferred();
  h.provider.spokenReply.compose = () => completion.promise;
  const pending = h.provider.handleSend('旧问题'); await settle();
  h.runs[0].done.resolve({ status: 'finished', result: '完整文字结果' }); await settle();
  await h.provider.interrupt();
  completion.resolve({ text: '过期口语回答', fallback: false }); await pending;
  assert.ok(!h.events.some(e => e.type === 'speak' && e.text === '过期口语回答'));
  assert.equal(h.provider.spokenHistory.length, 1);
  assert.equal(h.provider.spokenHistory[0].delivery, 'interrupted');
});

test('disabled speech does not invoke extra model composition or immediate ack', async () => {
  const h = host(); h.settings.autoSpeak = false;
  const pending = h.provider.handleSend('问题'); await settle();
  h.runs[0].done.resolve({ status: 'finished', result: '完整文字' }); await pending;
  assert.equal(h.compositions.length, 0);
  assert.ok(!h.events.some(e => e.type === 'speak'));
});

test('follow-up gets previous spoken content; reset clears it', async () => {
  const h = host(); const first = h.provider.handleSend('先讲结论'); await settle();
  h.runs[0].done.resolve({ status: 'finished', result: '不能上线。' }); await first;
  await h.provider.interrupt();
  const second = h.provider.handleSend('为什么？'); await settle();
  h.runs[1].done.resolve({ status: 'finished', result: '验证没有通过。' }); await second;
  const interrupted = h.compositions[1].previousReplies.find(item => item.delivery === 'interrupted');
  assert.equal(interrupted?.text, '不能上线。');
  await h.provider.newSession(); assert.equal(h.provider.spokenHistory.length, 0);
});
