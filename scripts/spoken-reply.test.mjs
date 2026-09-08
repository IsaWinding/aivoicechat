import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['src/spokenReply.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['@cursor/sdk'], write: false });
const module = { exports: {} };
const sdkOptions = [];
const sdk = { Agent: { async create(options) {
  sdkOptions.push(options);
  return { async send() { return {
    async *stream() {}, async wait() { return { status: 'finished', result: '不能上线，验证还没有完成。' }; },
  }; }, async [Symbol.asyncDispose]() {} };
} } };
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === '@cursor/sdk' ? sdk : require(name), setTimeout, clearTimeout, AbortController });
const { SpokenReplyComposer, spokenReplyPrompt, isSpeakableReply } = module.exports;
const options = { apiKey: 'test-only', model: 'composer-2.5', cwd: 'test' };
const context = { latestQuestion: '能上线了吗？', recentConversation: [],
  fullResult: '已经修改代码。\n'.repeat(80) + '最终结论：验证未通过，不能上线。',
  status: 'finished', importantEvents: ['验证未通过'],
  previousReplies: [{ text: '已经定位到原因。', delivery: 'interrupted' }], language: 'zh-CN' };

test('speech-only agent has no tools and no ambient setting sources', async () => {
  const result = await new SpokenReplyComposer().compose(options, context);
  assert.equal(result.fallback, false);
  assert.equal(sdkOptions.at(-1).tools.length, 0);
  assert.equal(sdkOptions.at(-1).local.settingSources.length, 0);
  assert.equal(sdkOptions.at(-1).local.enableAgentRetries, false);
});

test('prompt includes latest focus, tail conclusion, anomalies, and interrupted history', () => {
  const prompt = spokenReplyPrompt(context);
  for (const text of ['能上线了吗', '最终结论：验证未通过', '已经定位到原因', 'interrupted']) assert.ok(prompt.includes(text));
  assert.ok(prompt.includes('不要摘抄第一段'));
  assert.ok(prompt.includes('禁止逐条朗读命令原文'));
});

test('isSpeakableReply rejects command dumps but allows intent summaries', () => {
  assert.equal(isSpeakableReply('不能上线，验证还没有完成。'), true);
  assert.equal(isSpeakableReply('需要先安装依赖，再编译打包，具体命令看文字。'), true);
  assert.equal(isSpeakableReply('npm install 然后 npm run build'), false);
  assert.equal(isSpeakableReply('先运行 git clone 再 cd 进去'), false);
  assert.equal(isSpeakableReply('第一步执行 pip install，第二步 python main.py'), false);
  assert.equal(isSpeakableReply('请运行 docker compose up --build'), false);
  assert.equal(isSpeakableReply(''), false);
  assert.equal(isSpeakableReply('长'.repeat(221)), false);
});

test('cancellation during initialization returns promptly and prevents subsequent send', async () => {
  let ready; let sends = 0; let disposed = 0;
  const session = { ensure: () => new Promise(resolve => { ready = resolve; }),
    async send() { sends++; }, async cancel() {}, async dispose() { disposed++; } };
  const composer = new SpokenReplyComposer(() => session);
  const pending = composer.compose(options, context); composer.cancel();
  assert.equal(await pending, undefined);
  ready(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 0); assert.equal(disposed, 1);
});

test('timeout falls back without reading a potentially misleading excerpt', async () => {
  const session = { ensure: () => new Promise(() => {}), async cancel() {}, async dispose() {} };
  const reply = await new SpokenReplyComposer(() => session, 5).compose(options, { ...context, status: 'error' });
  assert.equal(reply.fallback, true); assert.match(reply.text, /没有完成/);
});

test('overlong or code-containing outputs use explicit fallback', async () => {
  for (const text of ['npm test', '先运行 npm install 再 npm run build', '```js test```', '长'.repeat(221), '']) {
    const session = { async ensure() {}, async send() { return { status: 'finished', result: text }; }, async cancel() {}, async dispose() {} };
    const reply = await new SpokenReplyComposer(() => session).compose(options, context);
    assert.equal(reply.fallback, true);
  }
});
