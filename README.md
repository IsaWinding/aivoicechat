# AI 语音聊天（Cursor 扩展）

在 Cursor 侧边栏用语音或文字下达任务。扩展通过 Cursor SDK 在本机对当前工作区启动 Agent，并把进度以文字和语音回流到同一面板。

## 准备

- Cursor / VS Code（扩展宿主 Node.js ≥ 22.13）
- [Cursor API Key](https://cursor.com/dashboard/integrations)
- 已打开一个工作区文件夹

## 安装与调试

```bash
npm install
npm run compile
```

然后任选一种方式：

1. **F5 调试**：用 Cursor 打开本仓库，按 `F5` 启动扩展开发宿主。
2. **安装 VSIX**：`npx @vscode/vsce package`，再在 Cursor 里「从 VSIX 安装」。

打开侧边栏「AI 语音聊天」，或命令面板搜索「打开 AI 语音聊天」。

## 配置

在设置中搜索 `aivoicechat`：

| 项 | 说明 |
| --- | --- |
| `aivoicechat.apiKey` | Cursor API Key。也可设环境变量 `CURSOR_API_KEY` |
| `aivoicechat.model` | 默认 `composer-2.5` |
| `aivoicechat.language` | 语音语言，默认 `zh-CN` |
| `aivoicechat.autoSpeak` | 是否自动播报进度和结论 |

## 用法

- 在输入框打字，`Enter` 发送，`Shift+Enter` 换行
- 点击「语音」开始识别，再点一次停止；识别结果可改后再发送
- 按住麦克风（触摸或按住 Shift 再按鼠标）说话，松手后自动发送
- 任务进行中可点「取消」
- 「播报开/关」控制是否朗读进度
- 「新会话」会结束当前 Agent 并清空对话

状态栏右侧的「语音聊天」可快速打开面板并切换麦克风。

## 语音说明

Cursor / VS Code 的 Webview 不允许访问麦克风（无法弹出授权），因此语音输入默认走**浏览器桥**：点击麦克风或光球时，扩展在本机 `127.0.0.1` 起一个带随机令牌的小服务，并用系统浏览器打开识别页。浏览器会正常弹出「允许使用麦克风」，允许后直接说话，说完一句自动发给 Cursor 执行；Cursor 的进度和结论也会同步显示在该页面。

- 推荐用 Edge 打开（国内网络下 Chrome 的语音服务可能连不上）
- 页面保持打开即可反复说话；关闭页面后再点麦克风会重新打开
- 如需改回面板内识别，把 `aivoicechat.speechInput` 设为 `webview`（多数环境不可用）

**语音播报**由 `aivoicechat.speechOutput` 控制，默认 `auto`：

- Windows 上使用系统语音引擎（System.Speech，选择已安装的中文音色），不受浏览器「需先点击才可播放」策略限制；朗读期间浏览器页会自动暂停识别
- 其他系统使用浏览器页朗读（页面需被点击过一次），无浏览器页时在 Cursor 面板内朗读
- 会朗读完整回答（自动去掉 Markdown 符号、代码块，超过约 600 字会截断并提示看文字）

云端 Whisper / Azure / 阿里接口已预留在 `src/voice/`，第一版未接通。

## 注意

- SDK 跑的是独立 Agent，不会出现在你正在看的那条 Cursor 聊天里，进度以本面板为准。
- 本地 Agent 会按默认策略自动执行读文件、改文件、跑命令等工具，请只在可信工作区使用。
