(() => {
  const vscode = acquireVsCodeApi();
  const timeline = document.getElementById("timeline");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const micBtn = document.getElementById("micBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  const speakToggle = document.getElementById("speakToggle");
  const testBtn = document.getElementById("testBtn");
  const newSessionBtn = document.getElementById("newSession");
  const expandBtn = document.getElementById("expandBtn");
  const orbBtn = document.getElementById("orbBtn");
  const statusTitle = document.getElementById("statusTitle");
  const statusSub = document.getElementById("statusSub");
  const statusIcon = document.getElementById("statusIcon");
  const hint = document.getElementById("hint");
  const sheet = document.getElementById("sheet");
  const workspaceEl = document.getElementById("workspace");
  const keyBanner = document.getElementById("keyBanner");
  const openSettings = document.getElementById("openSettings");

  const recognizer = window.Voice.createRecognizer();
  const speaker = window.Voice.createSpeaker();

  let language = "zh-CN";
  let speechInput = "browser";
  let listening = false;
  let hostState = "idle";
  let holdToTalk = false;
  let draftBeforeListen = "";
  let sendTimer;
  const bubbles = new Map();

  function setStatus(state, label) {
    hostState = state;
    statusIcon.className = `status-icon ${state === "idle" ? "idle" : state}`;
    orbBtn.className = `orb ${state}`;
    statusSub.textContent = label;
    micBtn.classList.toggle("active", state === "listening");
    if (state === "idle") {
      hint.textContent = !speaker.enabled
        ? "语音播报已关闭，点右侧喇叭按钮开启"
        : speechInput === "browser"
          ? "点击光球，在浏览器中允许麦克风后说话"
          : "点击光球开始说话";
    } else if (state === "listening") {
      hint.textContent = speechInput === "browser" ? "浏览器正在聆听，说完自动发送" : "正在聆听… 再点一次发送";
    } else if (state === "running") {
      hint.textContent = "Cursor 正在执行";
    } else if (state === "speaking") {
      hint.textContent = "正在播报";
    }
  }

  function applySettings(settings) {
    language = settings.language || "zh-CN";
    speechInput = settings.speechInput || "browser";
    speaker.language = language;
    speaker.enabled = settings.autoSpeak !== false;
    if (!speaker.enabled) speaker.cancel();
    speakToggle.setAttribute("aria-pressed", speaker.enabled ? "true" : "false");
    speakToggle.classList.toggle("off", !speaker.enabled);
    speakToggle.title = speaker.enabled ? "语音播报：开（点击关闭）" : "语音播报：关（点击开启）";
    workspaceEl.textContent = settings.workspaceName ? `工作区：${settings.workspaceName}` : "未打开工作区";
    keyBanner.classList.toggle("hidden", Boolean(settings.hasApiKey));
    if (!settings.hasApiKey) {
      sheet.classList.remove("hidden");
    }
  }

  function addMessage(item) {
    const existing = bubbles.get(item.id);
    if (existing) {
      existing.body.textContent = item.text;
      existing.el.classList.toggle("pending", item.role === "assistant" && !item.done);
      return existing.el;
    }
    const el = document.createElement("article");
    el.className = `msg ${item.role}`;
    if (item.role !== "progress") {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = item.role === "user" ? "你" : "Cursor";
      el.appendChild(who);
    }
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = item.text;
    el.appendChild(body);
    timeline.appendChild(el);
    bubbles.set(item.id, { el, body });
    timeline.scrollTop = timeline.scrollHeight;
    return el;
  }

  function showWelcome() {
    timeline.innerHTML = "";
    bubbles.clear();
    statusTitle.textContent = "新对话";
    setStatus("idle", "准备就绪");
    addMessage({
      id: "welcome",
      role: "assistant",
      text: window.__WELCOME__ || "你好，用语音或文字告诉我要做什么。",
      done: true,
    });
  }

  function sendCurrent() {
    const text = input.value.trim();
    if (!text) {
      return;
    }
    speaker.cancel();
    stopListening(false);
    statusTitle.textContent = text;
    vscode.postMessage({ type: "send", text });
    input.value = "";
  }

  function startListening(fromHold) {
    if (listening) {
      return;
    }
    speaker.cancel();
    vscode.postMessage({ type: "interrupt" });
    holdToTalk = Boolean(fromHold);
    draftBeforeListen = input.value;
    listening = true;
    setStatus("listening", "聆听中");
    recognizer.start({
      language,
      onPartial: (text) => {
        clearTimeout(sendTimer);
        input.value = `${draftBeforeListen}${draftBeforeListen && text ? " " : ""}${text}`;
        statusTitle.textContent = input.value || "新对话";
      },
      onFinal: (text) => {
        const prefix = draftBeforeListen.trim();
        input.value = `${prefix}${prefix && text ? " " : ""}${text}`.trim();
        draftBeforeListen = input.value;
        statusTitle.textContent = input.value || "新对话";
        if (!holdToTalk) {
          clearTimeout(sendTimer);
          sendTimer = setTimeout(() => stopListening(true), 1200);
        }
      },
      onError: (message) => {
        stopListening(false);
        statusSub.textContent = message;
        addMessage({ id: `err-${Date.now()}`, role: "progress", text: message, done: true });
        sheet.classList.remove("hidden");
      },
      onEnd: () => {
        if (listening) {
          listening = false;
          if (hostState === "listening") {
            setStatus("idle", "准备就绪");
          }
        }
      },
    });
  }

  function stopListening(shouldSend) {
    clearTimeout(sendTimer);
    listening = false;
    holdToTalk = false;
    recognizer.stop();
    if (hostState === "listening") {
      setStatus("idle", "准备就绪");
    }
    if (shouldSend) {
      sendCurrent();
    }
  }

  function unlockSpeech() {
    speaker.unlock();
  }

  function toggleListen() {
    unlockSpeech();
    if (speechInput === "browser") {
      vscode.postMessage({ type: "toggleMic" });
      return;
    }

    if (listening) {
      stopListening(true);
    } else {
      startListening(false);
    }
  }

  orbBtn.addEventListener("click", toggleListen);
  micBtn.addEventListener("click", toggleListen);
  document.getElementById("statusCard").addEventListener("click", () => {
    sheet.classList.remove("hidden");
    input.focus();
  });
  sendBtn.addEventListener("click", () => {
    unlockSpeech();
    sendCurrent();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendCurrent();
    }
  });

  cancelBtn.addEventListener("click", () => {
    speaker.cancel();
    if (hostState === "running" || hostState === "speaking") {
      vscode.postMessage({ type: "cancel" });
      return;
    }
    if (listening) {
      stopListening(false);
      return;
    }
    vscode.postMessage({ type: "close" });
  });

  expandBtn.addEventListener("click", () => {
    sheet.classList.toggle("hidden");
  });

  speakToggle.addEventListener("click", () => {
    unlockSpeech();
    const enabled = !speaker.enabled;
    if (!enabled) {
      speaker.cancel();
    }
    // 真正的状态由扩展保存并通过 settings 消息广播回来，这里只发请求
    vscode.postMessage({ type: "setAutoSpeak", enabled });
  });

  testBtn.addEventListener("click", () => {
    // 这一下点击同时充当浏览器/面板播放所需的用户手势
    unlockSpeech();
    sheet.classList.remove("hidden");
    vscode.postMessage({ type: "testSpeak" });
  });

  newSessionBtn.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
  openSettings.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "init":
        applySettings(message.settings);
        timeline.innerHTML = "";
        bubbles.clear();
        if (!message.messages?.length) {
          showWelcome();
        } else {
          for (const item of message.messages) {
            addMessage(item);
            if (item.role === "user") {
              statusTitle.textContent = item.text;
            }
          }
          setStatus("idle", "准备就绪");
        }
        break;
      case "stopSpeech":
        speaker.cancel();
        break;
      case "sessionReset":
        speaker.cancel();
        applySettings(message.settings);
        showWelcome();
        break;
      case "settings":
        applySettings(message.settings);
        if (hostState === "idle") {
          setStatus("idle", statusSub.textContent);
        }
        break;
      case "userMessage":
        addMessage({ id: message.id, role: "user", text: message.text, done: true });
        statusTitle.textContent = message.text;
        break;
      case "assistantStart":
        addMessage({ id: message.id, role: "assistant", text: "", done: false });
        break;
      case "assistantDelta": {
        const current = bubbles.get(message.id);
        addMessage({
          id: message.id,
          role: "assistant",
          text: `${current?.body.textContent || ""}${message.text}`,
          done: false,
        });
        break;
      }
      case "assistantDone": {
        const current = bubbles.get(message.id);
        if (current) {
          if (typeof message.text === "string") current.body.textContent = message.text;
          current.el.classList.remove("pending");
        }
        statusIcon.className = "status-icon done";
        break;
      }
      case "progress":
        addMessage({ id: message.id, role: "progress", text: message.text, done: true });
        statusSub.textContent = message.text;
        break;
      case "status":
        setStatus(message.state, message.label);
        break;
      case "speak": {
        // 试听不受「语音播报」开关影响
        const wasEnabled = speaker.enabled;
        if (message.test) {
          speaker.enabled = true;
        }
        speaker.speak(message.text, {
          language,
          onStart: () => {
            if (hostState === "running") {
              return;
            }
            setStatus("speaking", "播报中");
          },
          onEnd: () => {
            if (hostState !== "running" && !listening) {
              setStatus("idle", "准备就绪");
              statusIcon.className = "status-icon done";
            }
          },
          onNeedUnlock: () => {
            statusSub.textContent = "请点击光球或喇叭按钮，才能播放语音";
            hint.textContent = "浏览器/面板需要先点击一次，才能播报 Cursor 的回答";
          },
          onError: (message) => {
            statusSub.textContent = message;
            addMessage({ id: `speak-${Date.now()}`, role: "progress", text: message, done: true });
          },
        });
        if (message.test) {
          speaker.enabled = wasEnabled;
        }
        break;
      }
      case "error":
        addMessage({ id: `err-${Date.now()}`, role: "progress", text: message.message, done: true });
        statusSub.textContent = message.message;
        sheet.classList.remove("hidden");
        break;
      case "startListening":
        startListening(false);
        break;
      case "stopListening":
        stopListening(false);
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
