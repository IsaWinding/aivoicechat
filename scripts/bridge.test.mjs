import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/micBridge.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), URL });
const { MicBridge } = module.exports;

test('real HTTP bridge deduplicates transcript retries and dispatches interrupts', async () => {
  const transcripts = []; let interrupts = 0;
  const bridge = new MicBridge(resolve('media'), { onTranscript: text => transcripts.push(text), onListening() {}, onInterrupt() { interrupts++; } });
  try {
    const url = new URL(await bridge.start());
    for (const path of ['/transcript', '/transcript', '/interrupt']) {
      url.pathname = path;
      const response = await fetch(url, { method: 'POST', headers: { Connection: 'close' }, body: JSON.stringify({ id: 'same-utterance', text: '只执行一次' }) });
      assert.equal(response.status, 204); await response.text();
    }
    assert.deepEqual(transcripts, ['只执行一次']); assert.equal(interrupts, 1);
  } finally { bridge.dispose(); }
});

test('bridge rejects wrong tokens without submitting messages', async () => {
  let submitted = false;
  const bridge = new MicBridge(resolve('media'), { onTranscript() { submitted = true; }, onListening() {} });
  try {
    const url = new URL(await bridge.start()); url.pathname = '/transcript'; url.search = '?t=wrong';
    const response = await fetch(url, { method: 'POST', headers: { Connection: 'close' }, body: JSON.stringify({ text: 'test' }) });
    assert.equal(response.status, 403); await response.text(); assert.equal(submitted, false);
  } finally { bridge.dispose(); }
});
