import * as vscode from "vscode";
import { ChatPanelProvider } from "./chatPanel";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatPanelProvider(context.extensionUri);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  status.command = "aivoicechat.open";
  status.text = "$(mic) 语音聊天";
  status.tooltip = "打开语音聊天弹窗（Ctrl+Alt+V）";
  status.show();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.explorerViewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("aivoicechat.open", () => provider.open()),
    vscode.commands.registerCommand("aivoicechat.toggleMic", () => {
      provider.open();
      provider.toggleMic();
    }),
    vscode.commands.registerCommand("aivoicechat.newSession", () => {
      void provider.newSession();
    }),
    vscode.commands.registerCommand("aivoicechat.cancel", () => {
      void provider.cancel();
    }),
    vscode.commands.registerCommand("aivoicechat.testSpeak", () => {
      provider.testSpeak();
    }),
    status,
    {
      dispose: () => {
        void provider.dispose();
      },
    },
  );
}

export function deactivate(): void {}
