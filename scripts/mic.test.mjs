import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Execute the shipped page script; only browser APIs and time are simulated.
function page() {
  let now = 10000;
  let nextId = 0;
  const timers = new Map();
  const requests = [];
  const elements = new Map();
  const recognizers = [];
  const utterances = [];
  let failRequests = false;
  function element() {
    const events = {};
    return { textContent: '', innerHTML: '', checked: true, events,
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(name, fn) { events[name] = fn; }, appendChild() {},
    };
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element, addEventListener() {},
  };
  class Recognition {
    constructor() { recognizers.push(this); }
    start() { this.onstart?.(); }
    stop() { this.onend?.(); }
    result(text, final = true) {
      const result = [{ transcript: text }]; result.isFinal = final;
      this.onresult({ resultIndex: 0, results: [result] });
    }
  }
  const context = vm.createContext({ document,
    window: { SpeechRecognition: Recognition, speechSynthesis: {
      getVoices: () => [], addEventListener() {}, cancel() {}, speak(u) { utterances.push(u); },
    } },
    navigator: { language: 'zh-CN', userActivation: { hasBeenActive: true } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    EventSource: class {}, Date: { now: () => now },
    setTimeout(fn, ms) { timers.set(++nextId, { at: now + ms, fn }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      requests.push({ path: url.split('?')[0], ...JSON.parse(options.body) });
      return { ok: !failRequests, status: failRequests ? 503 : 204 };
    },
  });
  vm.runInContext(readFileSync('media/mic.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return {
    run: code => vm.runInContext(code, context),
    start() { vm.runInContext('start()', context); return recognizers.at(-1); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        timers.delete(entry[0]); now = entry[1].at; entry[1].fn();
      }
      now = end;
    },
    requests, elements, utterances,
    fail() { failRequests = true; },
    recover() { failRequests = false; },
  };
}

test('short pauses combine consecutive final recognition fragments', async () => {
  const p = page(); const r = p.start();
  r.result('先看下登录'); p.tick(800); r.result('不要改代码'); p.tick(1199);
  assert.equal(p.requests.filter(r => r.path === '/transcript').length, 0);
  p.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.requests.find(r => r.path === '/transcript').text, '先看下登录 不要改代码');
});

test('partial speech interrupts once and delays submission', () => {
  const p = page(); const r = p.start();
  p.run('pauseMic()'); r.result('等一下', false); r.result('我想改一下', false);
  assert.equal(p.run('speaking'), false);
  assert.equal(p.requests.filter(r => r.path === '/interrupt').length, 1);
  p.tick(5000);
  assert.equal(p.requests.filter(r => r.path === '/transcript').length, 0);
});

test('stopping recognition must not submit buffered text from onend', () => {
  const p = page(); const r = p.start();
  r.result('这句话先别发'); p.run('stop()'); p.tick(3000);
  assert.equal(p.requests.filter(r => r.path === '/transcript').length, 0);
});

test('recognition error must not auto-submit an unfinished utterance', () => {
  const p = page(); const r = p.start();
  r.result('我还没说完'); r.onerror({ error: 'network' }); r.onend(); p.tick(3000);
  assert.equal(p.requests.filter(r => r.path === '/transcript').length, 0);
});

test('failed delivery preserves text for explicit retry', async () => {
  const p = page(); const r = p.start();
  p.fail(); r.result('请保留这句话'); p.tick(1200);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(p.elements.get('interim').textContent, /请保留这句话/);
  p.recover(); p.elements.get('retryBtn').events.click();
  await new Promise(resolve => setImmediate(resolve));
  const submissions = p.requests.filter(r => r.path === '/transcript');
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0].id, submissions[1].id, 'retry reuses idempotency id');
  assert.equal(p.elements.get('retryBtn').hidden, true);
});

test('speech start cancels a pending send before transcription arrives', () => {
  const p = page(); const r = p.start();
  r.result('第一句'); p.tick(900); r.onspeechstart(); p.tick(1500);
  assert.equal(p.requests.filter(r => r.path === '/transcript').length, 0);
});

test('recognizer end does not send a final fragment while a later partial is unresolved', () => {
  const p = page(); const r = p.start();
  r.result('第一句'); r.result('还有第二句', false); r.onend(); p.tick(3000);
  assert.equal(p.requests.filter(r => r.path === '/transcript').length, 0);
});

test('muting invalidates pending delayed playback', () => {
  const p = page();
  p.run('speak("旧回答。"); speak("待播放回答。"); applyAutoSpeak(false)'); p.tick(200);
  assert.equal(p.utterances.length, 1);
});

test('clear prevents the previous interim draft resurfacing', () => {
  const p = page(); const r = p.start();
  r.result('旧草稿'); p.elements.get('clearBtn').events.click(); p.tick(3000);
  assert.equal(p.requests.filter(r => r.path === '/transcript').length, 0);
});
