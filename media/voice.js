(() => {
  /**
   * Web Speech 实现。接口与 src/voice/types.ts 对齐，
   * 后续云端引擎只需替换 window.Voice 的构造结果。
   */
  class WebSpeechRecognizer {
    constructor() {
      this.engine = "webspeech";
      this.recognition = null;
    }

    start(options) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        options.onError?.("当前环境不支持语音识别。可改用文字输入，或稍后接入云端语音。");
        return;
      }
      this.stop();
      const recognition = new SpeechRecognition();
      recognition.lang = options.language || "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => options.onStart?.();
      recognition.onerror = (event) => {
        const map = {
          "not-allowed": "没有麦克风权限。请在系统隐私设置中允许 Cursor 使用麦克风，然后重载窗口。",
          "audio-capture": "找不到麦克风，请检查输入设备。",
          "no-speech": "没有听到语音，请再试一次。",
          network: "语音识别需要网络，请检查连接。",
        };
        options.onError?.(map[event.error] || `语音识别出错：${event.error}`);
      };
      recognition.onresult = (event) => {
        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result.isFinal) {
            finalText += result[0].transcript;
          } else {
            interim += result[0].transcript;
          }
        }
        if (interim) {
          options.onPartial?.(interim);
        }
        if (finalText) {
          options.onFinal?.(finalText.trim());
        }
      };
      recognition.onend = () => {
        this.recognition = null;
        options.onEnd?.();
      };
      this.recognition = recognition;
      try {
        recognition.start();
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
      }
    }

    stop() {
      if (!this.recognition) {
        return;
      }
      try {
        this.recognition.stop();
      } catch {
        // ignore
      }
      this.recognition = null;
    }
  }

  function pickVoice(lang) {
    const prefix = (lang || "zh").slice(0, 2).toLowerCase();
    const voices = window.speechSynthesis?.getVoices() || [];
    return (
      voices.find((voice) => /zh[-_]CN/i.test(voice.lang) && /Xiaoxiao|Yunxi|Natural|Huihui|Yaoyao/i.test(voice.name)) ||
      voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith(prefix)) ||
      voices.find((voice) => /^zh/i.test(voice.lang || "")) ||
      null
    );
  }

  function chunkSpeech(text, maxLen = 90) {
    const parts = text.split(/(?<=[。！？；!?;\n])/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    let buf = "";
    for (const part of parts) {
      if ((buf + part).length > maxLen && buf) {
        out.push(buf);
        buf = part;
      } else {
        buf += part;
      }
    }
    if (buf) {
      out.push(buf);
    }
    return out.length ? out : [text];
  }

  class WebSpeechSpeaker {
    constructor() {
      this.engine = "webspeech";
      this.generation = 0;
      this.enabled = true;
      this.language = "zh-CN";
      this.unlocked = false;
      this.pendingSpeech = [];
      this.queue = [];
      this.currentUtter = null;
      this.activeOptions = null;
      if (window.speechSynthesis) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.addEventListener("voiceschanged", () => window.speechSynthesis.getVoices());
      }
      if (navigator.userActivation?.hasBeenActive) {
        this.unlocked = true;
      }
    }

    unlock() {
      if (this.unlocked || !window.speechSynthesis) {
        return;
      }
      this.unlocked = true;
      try {
        const warm = new SpeechSynthesisUtterance(" ");
        warm.volume = 0;
        window.speechSynthesis.speak(warm);
      } catch {
        // ignore
      }
      if (this.pendingSpeech.length) {
        const text = this.pendingSpeech.join(" ");
        this.pendingSpeech = [];
        const generation = this.generation;
        setTimeout(() => { if (generation === this.generation) this.speak(text, this.activeOptions || undefined); }, 150);
      }
    }

    pump() {
      if (!window.speechSynthesis || this.currentUtter) {
        return;
      }
      const part = this.queue.shift();
      if (!part) {
        this.activeOptions?.onEnd?.();
        this.activeOptions = null;
        return;
      }
      const utterance = new SpeechSynthesisUtterance(part);
      utterance.lang = this.activeOptions?.language || this.language;
      const preferred = pickVoice(utterance.lang);
      if (preferred) {
        utterance.voice = preferred;
      }
      const generation = this.generation;
      let started = false;
      utterance.onstart = () => {
        if (generation !== this.generation) return;
        started = true;
        this.activeOptions?.onStart?.();
      };
      utterance.onend = () => {
        if (generation !== this.generation) return;
        this.currentUtter = null;
        this.pump();
      };
      utterance.onerror = (event) => {
        if (generation !== this.generation) return;
        this.currentUtter = null;
        if (event.error === "interrupted" || event.error === "canceled") {
          this.queue = [];
          this.activeOptions?.onEnd?.();
          this.activeOptions = null;
          return;
        }
        this.activeOptions?.onError?.(event.error || "播报失败");
        this.pump();
      };
      this.currentUtter = utterance;
      window.speechSynthesis.speak(utterance);
      setTimeout(() => {
        if (!started && this.currentUtter === utterance) {
          this.unlocked = false;
          window.speechSynthesis.cancel();
          this.currentUtter = null;
          this.pendingSpeech.push(part, ...this.queue);
          this.queue = [];
          this.activeOptions?.onEnd?.();
          this.activeOptions?.onNeedUnlock?.();
          this.activeOptions = null;
        }
      }, 3000);
    }

    speak(text, options) {
      if (!this.enabled || !text) {
        return;
      }
      if (!window.speechSynthesis) {
        options?.onError?.("当前面板不支持语音播报，请确认「播报开」已开启，或使用浏览器语音页。");
        return;
      }
      if (!this.unlocked) {
        this.pendingSpeech.push(text);
        this.activeOptions = options || null;
        options?.onNeedUnlock?.();
        return;
      }
      const generation = ++this.generation;
      const parts = chunkSpeech(text);
      if (this.currentUtter || this.queue.length) {
        this.queue = [];
        window.speechSynthesis.cancel();
        this.currentUtter = null;
        this.activeOptions = options || null;
        setTimeout(() => {
          if (generation !== this.generation) return;
          this.queue = parts;
          this.pump();
        }, 120);
        return;
      }
      this.activeOptions = options || null;
      this.queue = parts;
      this.pump();
    }

    cancel() {
      this.generation++;
      this.queue = [];
      this.pendingSpeech = [];
      this.currentUtter = null;
      this.activeOptions = null;
      window.speechSynthesis?.cancel();
    }
  }

  window.Voice = {
    createRecognizer: () => new WebSpeechRecognizer(),
    createSpeaker: () => new WebSpeechSpeaker(),
  };
})();
