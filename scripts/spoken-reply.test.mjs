import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/spokenReply.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports });
const { SpokenReplyComposer, composeSpokenReply, spokenReplyPrompt, isSpeakableReply } = module.exports;
const context = { latestQuestion: '能上线了吗？', recentConversation: [],
  fullResult: '修改已经完成。\n\n验证未通过，不能上线。', status: 'finished',
  importantEvents: ['验证未通过'], previousReplies: [], language: 'zh-CN' };

test('local composer extracts speech without creating another agent', async () => {
  const result = await new SpokenReplyComposer().compose({}, context);
  assert.equal(result.fallback, false);
  assert.match(result.text, /修改已经完成/);
  assert.match(result.text, /验证未通过/);
});

test('error outcome always says the task did not complete', () => {
  const result = composeSpokenReply({ ...context, status: 'error', fullResult: '已经修改部分代码。' });
  assert.match(result.text, /没有完成/);
});

test('empty result uses an explicit status fallback', () => {
  assert.match(composeSpokenReply({ ...context, fullResult: '', status: 'finished' }).text, /处理完成/);
  assert.match(composeSpokenReply({ ...context, fullResult: '', status: 'error' }).text, /没有完成/);
});

test('prompt helper retains critical context for compatibility', () => {
  const prompt = spokenReplyPrompt(context);
  for (const text of ['能上线了吗', '验证未通过', '禁止逐条朗读命令原文']) assert.ok(prompt.includes(text));
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
