import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import "./App.css";

function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

type Role = "user" | "assistant";
type Lang = "en" | "fa";
type Perm = "default" | "acceptEdits" | "bypassPermissions";

interface Message {
  role: Role;
  content: string;
  streaming?: boolean;
  error?: boolean;
  kind?: "tool";
}

interface Tab {
  id: string;
  title: string;
  messages: Message[];
  cwd: string;
  sessionId?: string;
  permission: Perm;
}

interface Settings {
  lang: Lang;
}

const PERMS: { id: Perm; en: string; fa: string }[] = [
  { id: "default", en: "Safe (ask)", fa: "امن (پرسش)" },
  { id: "acceptEdits", en: "Accept edits", fa: "تأیید ویرایش‌ها" },
  { id: "bypassPermissions", en: "Full access", fa: "دسترسی کامل" },
];

const STR = {
  en: {
    brand: "Claude for Linux",
    clear: "Clear conversation",
    settings: "Settings",
    newTab: "New tab",
    tab: (n: number) => `Session ${n}`,
    folder: "Project folder:",
    folderPick: "Click to choose… (empty = current folder)",
    choose: "📁 Choose",
    terminal: "Open terminal here",
    clearField: "Clear",
    perm: "Permissions",
    cliNotFound: "claude not found",
    empty: "Write a command for Claude Code — e.g. “summarize the files in this project”.",
    ph: "Command for Claude Code…",
    send: "Send",
    stop: "Stop",
    cliHint:
      "Claude Code uses your existing terminal login (run `claude` once in a terminal to authenticate). No API key needed.",
    language: "Language",
    cancel: "Close",
    about: "About",
    madeBy: "Made by",
    creator: "Amin Asaadi",
    pickTitle: "Choose project folder",
    dropHint: "Drop files to add their paths",
    notLoggedIn:
      "🔒 You're not logged in to Claude Code.\nOpen a terminal and run:  claude\nComplete the browser login, then try again here.",
  },
  fa: {
    brand: "Claude برای لینوکس",
    clear: "پاک کردن گفتگو",
    settings: "تنظیمات",
    newTab: "تب جدید",
    tab: (n: number) => `جلسه ${n}`,
    folder: "پوشه‌ی پروژه:",
    folderPick: "برای انتخاب کلیک کن… (خالی = پوشه‌ی فعلی)",
    choose: "📁 انتخاب",
    terminal: "باز کردن ترمینال در این پوشه",
    clearField: "پاک کردن",
    perm: "دسترسی‌ها",
    cliNotFound: "claude یافت نشد",
    empty: "یک دستور برای Claude Code بنویس — مثلاً «فایل‌های این پروژه را خلاصه کن».",
    ph: "دستور برای Claude Code…",
    send: "ارسال",
    stop: "توقف",
    cliHint:
      "Claude Code از لاگین موجودِ ترمینالت استفاده می‌کند (یک‌بار در ترمینال `claude` بزن و احراز هویت کن). به کلید API نیازی نیست.",
    language: "زبان",
    cancel: "بستن",
    about: "درباره",
    madeBy: "ساخته‌ی",
    creator: "امین اسعدی",
    pickTitle: "انتخاب پوشه‌ی پروژه",
    dropHint: "فایل‌ها را رها کن تا آدرسشان اضافه شود",
    notLoggedIn:
      "🔒 هنوز وارد Claude Code نشده‌ای.\nیک ترمینال باز کن و بزن:  claude\nلاگین مرورگری را کامل کن، بعد دوباره همین‌جا امتحان کن.",
  },
} as const;

interface StreamPayload {
  id: string;
  text: string;
}
interface SessionPayload {
  id: string;
  session_id: string;
}
interface IdPayload {
  id: string;
}
interface ErrPayload {
  id: string;
  message: string;
}

let tabCounter = 1;
function newTab(lang: Lang): Tab {
  return {
    id: crypto.randomUUID(),
    title: STR[lang].tab(tabCounter++),
    messages: [],
    cwd: "",
    permission: "default",
  };
}

function App() {
  const [settings, setSettings] = useState<Settings>({ lang: "en" });
  const lang = settings.lang;
  const t = STR[lang];

  const [showSettings, setShowSettings] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab("en")]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const [input, setInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);

  const reqToTab = useRef<Record<string, string>>({});
  const tabReq = useRef<Record<string, string>>({}); // tabId -> in-flight reqId (for Stop)
  const tRef = useRef(t);
  tRef.current = t;
  const scrollRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  const activeTab = tabs.find((tb) => tb.id === activeId) ?? tabs[0];
  const messages = activeTab ? activeTab.messages : [];
  const busy = !!messages[messages.length - 1]?.streaming;

  useEffect(() => {
    invoke<Settings>("load_settings").then((s) => setSettings({ lang: (s.lang as Lang) || "en" }));
    invoke<string | null>("claude_check").then(setClaudeVersion);
    invoke<string>("load_session")
      .then((raw) => {
        if (raw) {
          const data = JSON.parse(raw);
          if (Array.isArray(data.tabs) && data.tabs.length) {
            setTabs(data.tabs.map((tb: Tab) => ({ ...tb, permission: tb.permission ?? "default" })));
            if (data.activeId) setActiveId(data.activeId);
            if (typeof data.counter === "number") tabCounter = data.counter;
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
      });
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const sanitized = tabs.map((tb) => ({
        ...tb,
        messages: tb.messages.map((m) => ({ ...m, streaming: false })),
      }));
      invoke("save_session", {
        data: JSON.stringify({ tabs: sanitized, activeId, counter: tabCounter }),
      }).catch(() => {});
    }, 400);
  }, [tabs, activeId]);

  // --- streaming helpers ---
  const appendDelta = useCallback((reqId: string, text: string) => {
    const tabId = reqToTab.current[reqId];
    if (!tabId) return;
    setTabs((ts) =>
      ts.map((tb) => {
        if (tb.id !== tabId) return tb;
        const msgs = [...tb.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.streaming) msgs[msgs.length - 1] = { ...last, content: last.content + text };
        return { ...tb, messages: msgs };
      })
    );
  }, []);

  const appendTool = useCallback((reqId: string, label: string) => {
    const tabId = reqToTab.current[reqId];
    if (!tabId) return;
    setTabs((ts) =>
      ts.map((tb) => {
        if (tb.id !== tabId) return tb;
        const msgs = [...tb.messages];
        const toolMsg: Message = { role: "assistant", kind: "tool", content: label };
        // keep the trailing streaming placeholder last
        if (msgs.length && msgs[msgs.length - 1].streaming) msgs.splice(msgs.length - 1, 0, toolMsg);
        else msgs.push(toolMsg);
        return { ...tb, messages: msgs };
      })
    );
  }, []);

  const setSession = useCallback((reqId: string, sid: string) => {
    const tabId = reqToTab.current[reqId];
    if (!tabId) return;
    setTabs((ts) => ts.map((tb) => (tb.id === tabId ? { ...tb, sessionId: sid } : tb)));
  }, []);

  const finishReq = useCallback((reqId: string, asError?: string) => {
    const tabId = reqToTab.current[reqId];
    if (!tabId) return;
    setTabs((ts) =>
      ts.map((tb) => {
        if (tb.id !== tabId) return tb;
        const msgs = [...tb.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.streaming) {
          msgs[msgs.length - 1] = {
            ...last,
            streaming: false,
            error: !!asError,
            content: asError ? (last.content || "") + asError : last.content,
          };
        }
        return { ...tb, messages: msgs };
      })
    );
    if (tabReq.current[tabId] === reqId) delete tabReq.current[tabId];
    delete reqToTab.current[reqId];
  }, []);

  useEffect(() => {
    const u: Array<Promise<() => void>> = [];
    u.push(listen("code://delta", (e: { payload: StreamPayload }) => appendDelta(e.payload.id, e.payload.text)));
    u.push(listen("code://tool", (e: { payload: StreamPayload }) => appendTool(e.payload.id, e.payload.text)));
    u.push(listen("code://session", (e: { payload: SessionPayload }) => setSession(e.payload.id, e.payload.session_id)));
    u.push(listen("code://done", (e: { payload: IdPayload }) => finishReq(e.payload.id)));
    u.push(
      listen("code://error", (e: { payload: ErrPayload }) =>
        finishReq(
          e.payload.id,
          e.payload.message === "NOT_LOGGED_IN" ? "\n\n" + tRef.current.notLoggedIn : "\n\n⚠️ " + e.payload.message
        )
      )
    );
    return () => u.forEach((p) => p.then((f) => f()));
  }, [appendDelta, appendTool, setSession, finishReq]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [tabs, activeId]);

  useEffect(() => {
    getCurrentWindow().setTitle(t.brand).catch(() => {});
  }, [t.brand]);

  // drag & drop files → insert paths
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") setDragOver(true);
      else if (p.type === "leave") setDragOver(false);
      else if (p.type === "drop") {
        setDragOver(false);
        const paths = (p.paths || []).map(quotePath);
        if (paths.length) setInput((prev) => (prev ? prev + " " : "") + paths.join(" "));
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // --- settings/tabs ---
  const setLang = (l: Lang) => {
    const next = { lang: l };
    setSettings(next);
    invoke("save_settings", { settings: next });
  };
  const addTab = () => {
    const tb = newTab(lang);
    setTabs((ts) => [...ts, tb]);
    setActiveId(tb.id);
  };
  const closeTab = (id: string) => {
    setTabs((ts) => {
      let rest = ts.filter((x) => x.id !== id);
      if (rest.length === 0) rest = [newTab(lang)];
      if (activeId === id) setActiveId(rest[0].id);
      return rest;
    });
  };
  const patchActive = (patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((tb) => (tb.id === activeTab.id ? { ...tb, ...patch } : tb)));

  const pickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t.pickTitle,
      defaultPath: activeTab?.cwd || undefined,
    });
    if (typeof selected === "string") patchActive({ cwd: selected });
  };
  const openTerminal = () => invoke("open_terminal", { cwd: activeTab?.cwd || null }).catch(() => {});

  // --- send / stop ---
  const send = async () => {
    const text = input.trim();
    if (!text || busy || !activeTab) return;
    const reqId = crypto.randomUUID();
    reqToTab.current[reqId] = activeTab.id;
    tabReq.current[activeTab.id] = reqId;
    setInput("");

    const userMsg: Message = { role: "user", content: text };
    const placeholder: Message = { role: "assistant", content: "", streaming: true };
    const isFirst = activeTab.messages.length === 0;

    setTabs((ts) =>
      ts.map((tb) =>
        tb.id === activeTab.id
          ? { ...tb, title: isFirst ? text.slice(0, 22) : tb.title, messages: [...tb.messages, userMsg, placeholder] }
          : tb
      )
    );

    try {
      await invoke("code_send", {
        requestId: reqId,
        prompt: text,
        cwd: activeTab.cwd || null,
        resume: activeTab.sessionId || null, // continue this tab's conversation
        permission: activeTab.permission,
      });
    } catch (err) {
      finishReq(reqId, "\n\n⚠️ " + String(err));
    }
  };

  const stop = () => {
    const reqId = tabReq.current[activeTab.id];
    if (reqId) invoke("code_stop", { requestId: reqId }).catch(() => {});
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const clearChat = () => {
    if (busy) return;
    patchActive({ messages: [], sessionId: undefined });
  };

  return (
    <div className="app" dir={lang === "fa" ? "rtl" : "ltr"}>
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-box">📎 {t.dropHint}</div>
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="logo">✳</span>
          <span>{t.brand}</span>
        </div>
        <div className="actions">
          <button onClick={clearChat} title={t.clear}>
            🗑
          </button>
          <button onClick={() => setShowSettings(true)} title={t.settings}>
            ⚙
          </button>
        </div>
      </header>

      <div className="tab-strip">
        {tabs.map((tb) => (
          <div
            key={tb.id}
            className={`tab ${tb.id === activeId ? "active" : ""}`}
            onClick={() => setActiveId(tb.id)}
            title={tb.title}
          >
            <span className="tab-title">{tb.title}</span>
            {tabs.length > 1 && (
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tb.id);
                }}
              >
                ✕
              </span>
            )}
          </div>
        ))}
        <button className="tab-add" onClick={addTab} title={t.newTab}>
          ＋
        </button>
      </div>

      <div className="cwd-bar">
        <label>{t.folder}</label>
        <input
          type="text"
          placeholder={t.folderPick}
          value={activeTab?.cwd ?? ""}
          readOnly
          onClick={pickFolder}
          style={{ cursor: "pointer" }}
        />
        <button className="browse-btn" onClick={pickFolder} title={t.choose}>
          {t.choose}
        </button>
        <button className="browse-btn" onClick={openTerminal} title={t.terminal}>
          🖥
        </button>
        {activeTab?.cwd && (
          <button className="browse-btn" onClick={() => patchActive({ cwd: "" })} title={t.clearField}>
            ✕
          </button>
        )}
        <select
          className="perm-select"
          value={activeTab?.permission ?? "default"}
          onChange={(e) => patchActive({ permission: e.target.value as Perm })}
          title={t.perm}
        >
          {PERMS.map((p) => (
            <option key={p.id} value={p.id}>
              {lang === "fa" ? p.fa : p.en}
            </option>
          ))}
        </select>
        <span className={claudeVersion ? "cli-ok" : "cli-bad"}>
          {claudeVersion ? `claude ${claudeVersion}` : t.cliNotFound}
        </span>
      </div>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && <div className="empty">{t.empty}</div>}
        {messages.map((m, i) =>
          m.kind === "tool" ? (
            <div key={i} className="tool-line">
              <span className="tool-ico">🔧</span>
              {m.content}
            </div>
          ) : (
            <div key={i} className={`msg ${m.role} ${m.error ? "err" : ""}`}>
              <div className="avatar">{m.role === "user" ? "🧑" : "✳"}</div>
              <div className="bubble">
                {m.role === "assistant" && m.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {m.content}
                  </ReactMarkdown>
                ) : (
                  m.content
                )}
                {m.streaming && <span className="cursor">▍</span>}
              </div>
            </div>
          )
        )}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t.ph}
          rows={1}
        />
        {busy ? (
          <button className="stop-btn" onClick={stop}>
            ⏹ {t.stop}
          </button>
        ) : (
          <button onClick={send} disabled={!input.trim()}>
            {t.send}
          </button>
        )}
      </div>

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t.settings}</h2>
            <label>{t.language}</label>
            <div className="lang-switch">
              <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
                English
              </button>
              <button className={lang === "fa" ? "active" : ""} onClick={() => setLang("fa")}>
                فارسی
              </button>
            </div>
            <p className="hint" style={{ marginTop: 14 }}>
              {t.cliHint}
            </p>
            <div className="about">
              <span className="about-label">{t.about}</span>
              <div className="about-row">
                <span>
                  {t.madeBy} <b>{t.creator}</b>
                </span>
                <a className="about-link" onClick={() => openUrl("https://aminasaadi.ir")}>
                  aminasaadi.ir
                </a>
              </div>
            </div>
            <div className="modal-actions">
              <button className="primary" onClick={() => setShowSettings(false)}>
                {t.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
