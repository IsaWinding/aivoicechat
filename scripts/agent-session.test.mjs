import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const prompts = [];
const sdk = { Agent: { async create() {
  return { async send(prompt) {
    prompts.push(prompt);
    return {
      async *stream() { yield { type: 'assistant', message: { content: [{ type: 'text', text: '完成。' }] } }; },
      async wait() { return { status: 'finished', result: '' }; },
      supports() { return false; },
    };
  }, async [Symbol.asyncDispose]() {} };
} } };
const compiled = await build({ entryPoints: ['src/agentSession.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['@cursor/sdk'], write: false });
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === '@cursor/sdk' ? sdk : require(name) });
const { AgentSession } = module.exports;

test('task prompt requires clarification before conflicting or ambiguous changes', async () => {
  const session = new AgentSession();
  await session.ensure({ apiKey: 'test', model: 'composer-2.5', cwd: 'test' });
  let streamed = '';
  await session.send('改一下', { onEvent() {}, onDelta: text => { streamed += text; } });
  assert.equal(streamed, '完成。');
  assert.match(prompts[0], /与项目现有设计\/约束冲突/);
  assert.match(prompts[0], /等待用户确认或拍板后再修改/);
  assert.match(prompts[0], /不得一边提问一边先改/);
});
