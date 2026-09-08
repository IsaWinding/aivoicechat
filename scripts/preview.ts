import { MicBridge } from '../src/micBridge';
import { resolve } from 'node:path';

// Isolated UI fixture: no Agent, credentials, file edits, or real model answers.
const bridge = new MicBridge(resolve('media'), {
  onTranscript: text => bridge.broadcast({ kind: 'assistant', text: `界面测试已接收：${text}（未调用模型）` }),
  onListening: () => {},
  onInterrupt: () => bridge.broadcast({ kind: 'stopSpeech', text: '' }),
  onAutoSpeak: autoSpeak => bridge.broadcast({ kind: 'settings', text: '', autoSpeak }),
  onTestSpeak: () => bridge.broadcast({ kind: 'speak', text: '这是本地界面测试。' }),
  initialEvents: () => [{ kind: 'settings', text: '', autoSpeak: true },
    { kind: 'progress', text: '本地界面测试：未连接模型，不会执行任务。' }],
});
bridge.start().then(url => console.log(url));
process.on('SIGINT', () => { bridge.dispose(); process.exit(0); });
