import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type Role = "user" | "assistant";
type Mode = "chat" | "code";

interface Message {
  role: Role;
  content: string;
  streaming?: boolean;
  error?: boolean;
}

interface Tab {
  id: string;
  mode: Mode;
  title: string;
  messages: Message[];
  cwd: string;
}

interface Settings {
  api_key: string;
  model: string;
  proxy: string;
}

const MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8 — توانمندترین" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — متعادل" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — سریع" },
];

interface StreamPayload {
  id: string;
  text: string;
}
interface IdPayload {
  id: string;
}
interface ErrPayload {
  id: string;
  message: string;
}

let tabCounter = 1;
function newTab(mode: Mode): Tab {
  return {
    id: crypto.randomUUID(),
    mode,
    title: mode === "chat" ? `گفتگو ${tabCounter++}` : `کد ${tabCounter++}`,
    messages: [],
    cwd: "",
  };
}

function App() {
  const [mode, setMode] = useState<Mode>("chat");
  const [settings, setSettings] = useState<Settings>({
    api_key: "",
    model: "claude-opus-4-8",
    proxy: "",
  });
  const [showSettings, setShowSettings] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [proxyDraft, setProxyDraft] = useState("");

  const [tabs, setTabs] = useState<Tab[]>(() => [newTab("chat"), newTab("code")]);
  const [active, setActive] = useState<Record<Mode, string>>(() => ({
    chat: tabs[0].id,
    code: tabs[1].id,
  }));
  const [input, setInput] = useState("");
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);

  // request id -> tab id, so streamed deltas land in the right tab
  const reqToTab = useRef<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const modeTabs = tabs.filter((t) => t.mode === mode);
  const activeTab = tabs.find((t) => t.id === active[mode]) ?? modeTabs[0];
  const messages = activeTab ? activeTab.messages : [];
  const busy = !!messages[messages.length - 1]?.streaming;

  useEffect(() => {
    invoke<Settings>("load_settings").then((s) => {
      setSettings(s);
      setKeyDraft(s.api_key);
      setProxyDraft(s.proxy || "");
    });
    invoke<string | null>("claude_check").then(setClaudeVersion);
  }, []);

  // --- per-tab streaming helpers (keyed by request id) ---
  const appendDelta = useCallback((reqId: string, text: string) => {
    const tabId = reqToTab.current[reqId];
    if (!tabId) return;
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== tabId) return t;
        const msgs = [...t.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.streaming) {
          msgs[msgs.length - 1] = { ...last, content: last.content + text };
        }
        return { ...t, messages: msgs };
      })
    );
  }, []);

  const finishReq = useCallback((reqId: string, asError?: string) => {
    const tabId = reqToTab.current[reqId];
    if (!tabId) return;
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== tabId) return t;
        const msgs = [...t.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.streaming) {
          msgs[msgs.length - 1] = {
            ...last,
            streaming: false,
            error: !!asError,
            content: asError ? (last.content || "") + asError : last.content,
          };
        }
        return { ...t, messages: msgs };
      })
    );
    delete reqToTab.current[reqId];
  }, []);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];
    const onDelta = (e: { payload: StreamPayload }) =>
      appendDelta(e.payload.id, e.payload.text);
    const onDone = (e: { payload: IdPayload }) => finishReq(e.payload.id);
    const onError = (e: { payload: ErrPayload }) =>
      finishReq(e.payload.id, "\n\n⚠️ " + e.payload.message);

    for (const ev of ["chat://delta", "code://delta"]) unlisteners.push(listen(ev, onDelta));
    for (const ev of ["chat://done", "code://done"]) unlisteners.push(listen(ev, onDone));
    for (const ev of ["chat://error", "code://error"]) unlisteners.push(listen(ev, onError));

    return () => unlisteners.forEach((p) => p.then((f) => f()));
  }, [appendDelta, finishReq]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [tabs, mode, active]);

  // --- settings ---
  const saveSettings = async () => {
    const next = { ...settings, api_key: keyDraft.trim(), proxy: proxyDraft.trim() };
    await invoke("save_settings", { settings: next });
    setSettings(next);
    setShowSettings(false);
  };
  const setModel = (model: string) => {
    const next = { ...settings, model };
    setSettings(next);
    invoke("save_settings", { settings: next });
  };

  // --- tabs ---
  const addTab = () => {
    const t = newTab(mode);
    setTabs((ts) => [...ts, t]);
    setActive((a) => ({ ...a, [mode]: t.id }));
  };
  const closeTab = (id: string) => {
    setTabs((ts) => {
      const t = ts.find((x) => x.id === id);
      if (!t) return ts;
      let rest = ts.filter((x) => x.id !== id);
      // never leave a mode with zero tabs
      if (!rest.some((x) => x.mode === t.mode)) {
        rest = [...rest, newTab(t.mode)];
      }
      if (active[t.mode] === id) {
        const fallback = rest.find((x) => x.mode === t.mode)!;
        setActive((a) => ({ ...a, [t.mode]: fallback.id }));
      }
      return rest;
    });
  };

  const patchActive = (patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === activeTab.id ? { ...t, ...patch } : t)));

  const pickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "انتخاب پوشه‌ی پروژه",
      defaultPath: activeTab?.cwd || undefined,
    });
    if (typeof selected === "string") patchActive({ cwd: selected });
  };

  // --- send ---
  const send = async () => {
    const text = input.trim();
    if (!text || busy || !activeTab) return;

    const reqId = crypto.randomUUID();
    reqToTab.current[reqId] = activeTab.id;
    setInput("");

    const userMsg: Message = { role: "user", content: text };
    const placeholder: Message = { role: "assistant", content: "", streaming: true };
    const isFirst = activeTab.messages.length === 0;
    const priorChat = [...activeTab.messages, userMsg]
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));

    setTabs((ts) =>
      ts.map((t) =>
        t.id === activeTab.id
          ? {
              ...t,
              title: isFirst ? text.slice(0, 22) : t.title,
              messages: [...t.messages, userMsg, placeholder],
            }
          : t
      )
    );

    try {
      if (mode === "chat") {
        await invoke("chat_send", {
          requestId: reqId,
          apiKey: settings.api_key,
          model: settings.model,
          system: null,
          messages: priorChat,
          proxy: settings.proxy || null,
        });
      } else {
        await invoke("code_send", {
          requestId: reqId,
          prompt: text,
          cwd: activeTab.cwd || null,
          proxy: settings.proxy || null,
        });
      }
    } catch (err) {
      finishReq(reqId, "\n\n⚠️ " + String(err));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const clearChat = () => {
    if (busy) return;
    patchActive({ messages: [] });
  };

  return (
    <div className="app" dir="rtl">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✳</span>
          <span>Claude برای لینوکس</span>
        </div>

        <div className="mode-switch">
          <button className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")}>
            گفتگو
          </button>
          <button className={mode === "code" ? "active" : ""} onClick={() => setMode("code")}>
            کد (Claude Code)
          </button>
        </div>

        <div className="actions">
          {mode === "chat" && (
            <select value={settings.model} onChange={(e) => setModel(e.target.value)} title="مدل">
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
          <button onClick={clearChat} title="پاک کردن گفتگو">
            🗑
          </button>
          <button onClick={() => setShowSettings(true)} title="تنظیمات">
            ⚙
          </button>
        </div>
      </header>

      {/* tab strip */}
      <div className="tab-strip">
        {modeTabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === active[mode] ? "active" : ""}`}
            onClick={() => setActive((a) => ({ ...a, [mode]: t.id }))}
            title={t.title}
          >
            <span className="tab-title">{t.title}</span>
            {modeTabs.length > 1 && (
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ✕
              </span>
            )}
          </div>
        ))}
        <button className="tab-add" onClick={addTab} title="تب جدید">
          ＋
        </button>
      </div>

      {mode === "code" && (
        <div className="cwd-bar">
          <label>پوشه‌ی پروژه:</label>
          <input
            type="text"
            placeholder="برای انتخاب کلیک کن… (خالی = پوشه‌ی فعلی)"
            value={activeTab?.cwd ?? ""}
            readOnly
            onClick={pickFolder}
            style={{ cursor: "pointer" }}
          />
          <button className="browse-btn" onClick={pickFolder} title="انتخاب پوشه">
            📁 انتخاب
          </button>
          {activeTab?.cwd && (
            <button className="browse-btn" onClick={() => patchActive({ cwd: "" })} title="پاک کردن">
              ✕
            </button>
          )}
          <span className={claudeVersion ? "cli-ok" : "cli-bad"}>
            {claudeVersion ? `claude ${claudeVersion}` : "claude یافت نشد"}
          </span>
        </div>
      )}

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            {mode === "chat"
              ? "یک پیام بنویس تا گفتگو را شروع کنی."
              : "یک دستور برای Claude Code بنویس — مثلاً «فایل‌های این پروژه را خلاصه کن»."}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? "err" : ""}`}>
            <div className="avatar">{m.role === "user" ? "🧑" : "✳"}</div>
            <div className="bubble">
              {m.content}
              {m.streaming && <span className="cursor">▍</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={mode === "chat" ? "پیامت را بنویس…" : "دستور برای Claude Code…"}
          rows={1}
        />
        <button onClick={send} disabled={busy || !input.trim()}>
          {busy ? "…" : "ارسال"}
        </button>
      </div>

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>تنظیمات</h2>

            <label>کلید API انتروپیک</label>
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="sk-ant-..."
            />

            <label style={{ marginTop: 14 }}>پراکسی (اختیاری)</label>
            <input
              type="text"
              value={proxyDraft}
              onChange={(e) => setProxyDraft(e.target.value)}
              placeholder="127.0.0.1:8080  یا  http://127.0.0.1:8080"
            />
            <p className="hint">
              اگر <code>api.anthropic.com</code> فیلتر است، آدرس پراکسی محلی‌ات را اینجا بگذار؛ هم
              چت و هم Claude Code از همین پراکسی رد می‌شوند. کلید فقط روی همین سیستم در{" "}
              <code>~/.config/claude-linux/</code> ذخیره می‌شود.
            </p>

            <div className="modal-actions">
              <button onClick={() => setShowSettings(false)}>انصراف</button>
              <button className="primary" onClick={saveSettings}>
                ذخیره
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
