import { useEffect, useRef, useState, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import TerminalView from "./Terminal";
import GitPanel from "./GitPanel";
import RemotePanel, { type RemoteConfig } from "./RemotePanel";
import "./App.css";

function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}
function isImage(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
}

type Role = "user" | "assistant";
type Lang = "en" | "fa";
type Perm = "default" | "acceptEdits" | "bypassPermissions";
type Theme = "dark" | "light";

interface Message {
  role: Role;
  content: string;
  streaming?: boolean;
  error?: boolean;
  kind?: "tool";
}
interface Usage {
  input: number;
  output: number;
}
type TabKind = "chat" | "terminal" | "git" | "remote";
interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  /** remote (SFTP/FTP) tabs: the connection draft for this tab */
  remote?: RemoteConfig;
  messages: Message[];
  cwd: string;
  sessionId?: string;
  permission: Perm;
  usage?: Usage;
  split?: boolean;
  restored?: boolean;
  /** terminal tabs: pass --dangerously-skip-permissions so Claude never stops
   * to ask (equivalent to "yes" / "yes, always" on every prompt) */
  skipPermissions?: boolean;
}
interface Settings {
  lang: Lang;
  proxy: string;
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
    newTab: "New chat tab",
    newTerm: "New terminal (full Claude Code)",
    newGit: "New Git panel",
    newRemote: "New SFTP / FTP connection",
    resume: "Resume a past session",
    tab: (n: number) => `Chat ${n}`,
    tabTerm: (n: number) => `Terminal ${n}`,
    tabGit: (n: number) => `Git ${n}`,
    tabRemote: (n: number) => `SFTP ${n}`,
    closeConfirm: (title: string) => `Close "${title}"?`,
    autoYes: "Auto-approve",
    autoYesHint: "Answer yes to every permission prompt (--dangerously-skip-permissions). Restarts this terminal.",
    folder: "Project folder:",
    folderPick: "Click to choose… (empty = current folder)",
    choose: "Choose folder",
    terminal: "Open external terminal here",
    split: "Split with a terminal",
    exportMd: "Export conversation (Markdown)",
    copy: "Copy",
    copied: "Copied",
    clearField: "Clear",
    perm: "Permissions",
    cliNotFound: "claude not found",
    empty: "Write a command for Claude Code — e.g. “summarize the files in this project”.",
    ph: "Command for Claude Code…",
    send: "Send",
    stop: "Stop",
    done: "Finished",
    tokens: "tokens",
    cliHint:
      "Claude Code uses your existing terminal login (run `claude` once in a terminal to authenticate). No API key needed.",
    language: "Language",
    theme: "Theme",
    dark: "Dark",
    light: "Light",
    fontSize: "Font size",
    cancel: "Close",
    proxy: "Proxy (optional)",
    proxyHint:
      "If api.anthropic.com is blocked, set your local proxy here; both chat and the terminal route the claude CLI through it.",
    proxySave: "Save",
    proxySaved: "Saved",
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
    newTab: "تب چت جدید",
    newTerm: "ترمینال جدید (Claude Code کامل)",
    newGit: "پنل Git جدید",
    newRemote: "اتصال SFTP / FTP جدید",
    resume: "ادامه‌ی یک جلسه‌ی قبلی",
    tab: (n: number) => `چت ${n}`,
    tabTerm: (n: number) => `ترمینال ${n}`,
    tabGit: (n: number) => `Git ${n}`,
    tabRemote: (n: number) => `SFTP ${n}`,
    closeConfirm: (title: string) => `«${title}» بسته شود؟`,
    autoYes: "تأیید خودکار",
    autoYesHint: "بله به همه‌ی درخواست‌های اجازه (--dangerously-skip-permissions). ترمینال را ری‌استارت می‌کند.",
    folder: "پوشه‌ی پروژه:",
    folderPick: "برای انتخاب کلیک کن… (خالی = پوشه‌ی فعلی)",
    choose: "انتخاب پوشه",
    terminal: "باز کردن ترمینال بیرونی در این پوشه",
    split: "تقسیم با یک ترمینال",
    exportMd: "خروجی گفتگو (Markdown)",
    copy: "کپی",
    copied: "کپی شد",
    clearField: "پاک کردن",
    perm: "دسترسی‌ها",
    cliNotFound: "claude یافت نشد",
    empty: "یک دستور برای Claude Code بنویس — مثلاً «فایل‌های این پروژه را خلاصه کن».",
    ph: "دستور برای Claude Code…",
    send: "ارسال",
    stop: "توقف",
    done: "تمام شد",
    tokens: "توکن",
    cliHint:
      "Claude Code از لاگین موجودِ ترمینالت استفاده می‌کند (یک‌بار در ترمینال `claude` بزن و احراز هویت کن). به کلید API نیازی نیست.",
    language: "زبان",
    theme: "تم",
    dark: "تیره",
    light: "روشن",
    fontSize: "اندازه فونت",
    cancel: "بستن",
    proxy: "پراکسی (اختیاری)",
    proxyHint:
      "اگر api.anthropic.com فیلتر است، آدرس پراکسی محلی‌ات را اینجا بگذار؛ هم چت و هم ترمینال، CLI claude را از همین پراکسی رد می‌کنند.",
    proxySave: "ذخیره",
    proxySaved: "ذخیره شد",
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
interface UsagePayload {
  id: string;
  input: number;
  output: number;
}
interface IdPayload {
  id: string;
}
interface ErrPayload {
  id: string;
  message: string;
}

let tabCounter = 1;
function newTab(lang: Lang, kind: TabKind = "chat", cwd = ""): Tab {
  const n = tabCounter++;
  const title =
    kind === "terminal"
      ? STR[lang].tabTerm(n)
      : kind === "git"
        ? STR[lang].tabGit(n)
        : kind === "remote"
          ? STR[lang].tabRemote(n)
          : STR[lang].tab(n);
  return {
    id: crypto.randomUUID(),
    kind,
    title,
    messages: [],
    cwd,
    permission: "default",
    ...(kind === "remote" ? { remote: newRemoteConfig() } : {}),
  };
}

function newRemoteConfig(): RemoteConfig {
  return { protocol: "sftp", host: "", port: 22, username: "", password: "", key_path: "", passphrase: "" };
}

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* ignore */
  }
}

function App() {
  const [settings, setSettings] = useState<Settings>({ lang: "en", proxy: "" });
  const lang = settings.lang;
  const t = STR[lang];
  const [proxyDraft, setProxyDraft] = useState("");

  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("theme") as Theme) || "dark"
  );
  const [fontSize, setFontSizeState] = useState<number>(
    () => Number(localStorage.getItem("fontSize")) || 14
  );

  const [showSettings, setShowSettings] = useState(false);
  // saved SFTP/FTP connections (persisted locally; may include passwords)
  const [savedRemotes, setSavedRemotes] = useState<RemoteConfig[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("savedRemotes") || "[]");
    } catch {
      return [];
    }
  });
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab("en")]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const [input, setInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const reqToTab = useRef<Record<string, string>>({});
  const tabReq = useRef<Record<string, string>>({});
  const tRef = useRef(t);
  tRef.current = t;
  const activeRef = useRef<{ id: string; kind: TabKind }>({ id: "", kind: "chat" });
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const langRef = useRef(lang);
  langRef.current = lang;
  const dragTab = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  const activeTab = tabs.find((tb) => tb.id === activeId) ?? tabs[0];
  const messages = activeTab ? activeTab.messages : [];
  const busy = !!messages[messages.length - 1]?.streaming;
  activeRef.current = { id: activeTab?.id ?? "", kind: activeTab?.kind ?? "chat" };

  // apply theme + font size (persisted in localStorage)
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.setProperty("--chat-font", fontSize + "px");
    localStorage.setItem("fontSize", String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    invoke<Settings>("load_settings").then((s) => {
      setSettings({ lang: (s.lang as Lang) || "en", proxy: s.proxy || "" });
      setProxyDraft(s.proxy || "");
    });
    invoke<string | null>("claude_check").then(setClaudeVersion);
    isPermissionGranted().then((g) => {
      if (!g) requestPermission();
    });
    invoke<string>("load_session")
      .then((raw) => {
        if (raw) {
          const data = JSON.parse(raw);
          if (Array.isArray(data.tabs) && data.tabs.length) {
            setTabs(
              data.tabs.map((tb: Tab) => ({
                ...tb,
                kind: tb.kind ?? "chat",
                permission: tb.permission ?? "default",
                restored: tb.kind === "terminal" ? true : undefined,
              }))
            );
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

  // auto-save (disk → survives app & system restart)
  useEffect(() => {
    if (!loaded.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const sanitized = tabs.map((tb) => {
        const { restored: _r, ...rest } = tb;
        return { ...rest, messages: tb.messages.map((m) => ({ ...m, streaming: false })) };
      });
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

  const setUsage = useCallback((reqId: string, u: Usage) => {
    const tabId = reqToTab.current[reqId];
    if (!tabId) return;
    setTabs((ts) => ts.map((tb) => (tb.id === tabId ? { ...tb, usage: u } : tb)));
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
    u.push(listen("code://usage", (e: { payload: UsagePayload }) => setUsage(e.payload.id, { input: e.payload.input, output: e.payload.output })));
    u.push(
      listen("code://done", (e: { payload: IdPayload }) => {
        const tabId = reqToTab.current[e.payload.id];
        finishReq(e.payload.id);
        if (document.hidden && tabId) {
          const tb = tabsRef.current.find((x) => x.id === tabId);
          notify(tRef.current.brand, `${tRef.current.done} — ${tb?.title ?? ""}`);
        }
      })
    );
    u.push(
      listen("code://error", (e: { payload: ErrPayload }) =>
        finishReq(
          e.payload.id,
          e.payload.message === "NOT_LOGGED_IN" ? "\n\n" + tRef.current.notLoggedIn : "\n\n⚠️ " + e.payload.message
        )
      )
    );
    return () => u.forEach((p) => p.then((f) => f()));
  }, [appendDelta, appendTool, setSession, setUsage, finishReq]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [tabs, activeId]);

  useEffect(() => {
    getCurrentWindow().setTitle(t.brand).catch(() => {});
  }, [t.brand]);

  // drag & drop files → chat input (with image preview) or into the terminal
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") setDragOver(true);
      else if (p.type === "leave") setDragOver(false);
      else if (p.type === "drop") {
        setDragOver(false);
        const raw = p.paths || [];
        const paths = raw.map(quotePath);
        if (!paths.length) return;
        const joined = paths.join(" ");
        if (activeRef.current.kind === "terminal") {
          invoke("pty_write", { termId: activeRef.current.id, data: joined + " " }).catch(() => {});
        } else {
          setInput((prev) => (prev ? prev + " " : "") + joined);
          const img = raw.find((x) => isImage(x));
          if (img) setImgPreview(img);
        }
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const code = e.code;
      const ts = tabsRef.current;
      const idx = ts.findIndex((x) => x.id === activeIdRef.current);
      if (code === "KeyT" && !e.shiftKey) {
        e.preventDefault();
        const tb = newTab(langRef.current);
        setTabs((p) => [...p, tb]);
        setActiveId(tb.id);
      } else if (code === "KeyT" && e.shiftKey) {
        e.preventDefault();
        const cur = ts.find((x) => x.id === activeIdRef.current);
        const tb = newTab(langRef.current, "terminal", cur?.cwd || "");
        setTabs((p) => [...p, tb]);
        setActiveId(tb.id);
      } else if (code === "KeyW") {
        e.preventDefault();
        const id = activeIdRef.current;
        setTabs((p) => {
          let rest = p.filter((x) => x.id !== id);
          if (rest.length === 0) rest = [newTab(langRef.current)];
          setActiveId(rest[Math.max(0, Math.min(idx, rest.length - 1))].id);
          return rest;
        });
      } else if (code === "Tab") {
        e.preventDefault();
        if (ts.length < 2) return;
        const next = (idx + (e.shiftKey ? -1 : 1) + ts.length) % ts.length;
        setActiveId(ts[next].id);
      } else if (/^Digit[1-9]$/.test(code)) {
        const n = Number(code.slice(5)) - 1;
        if (ts[n]) {
          e.preventDefault();
          setActiveId(ts[n].id);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // --- settings/tabs ---
  const setLang = (l: Lang) => {
    const next = { ...settings, lang: l };
    setSettings(next);
    invoke("save_settings", { settings: next });
  };
  const saveProxy = () => {
    const next = { ...settings, proxy: proxyDraft.trim() };
    setSettings(next);
    invoke("save_settings", { settings: next });
  };
  const addTab = () => {
    const tb = newTab(lang);
    setTabs((ts) => [...ts, tb]);
    setActiveId(tb.id);
  };
  const addTerminalTab = (extra?: string[]) => {
    const tb = newTab(lang, "terminal", activeTab?.cwd || "");
    if (extra) (tb as Tab & { _extra?: string[] })._extra = extra;
    setTabs((ts) => [...ts, tb]);
    setActiveId(tb.id);
  };
  const addGitTab = () => {
    const tb = newTab(lang, "git", activeTab?.cwd || "");
    setTabs((ts) => [...ts, tb]);
    setActiveId(tb.id);
  };
  const addRemoteTab = () => {
    const tb = newTab(lang, "remote");
    setTabs((ts) => [...ts, tb]);
    setActiveId(tb.id);
  };
  const setTabRemote = (id: string, remote: RemoteConfig) =>
    setTabs((ts) => ts.map((tb) => (tb.id === id ? { ...tb, remote } : tb)));
  const saveRemote = (cfg: RemoteConfig) => {
    setSavedRemotes((prev) => {
      // de-dupe by protocol/host/user; password is not stored in the chip key
      const key = (c: RemoteConfig) => `${c.protocol}|${c.host}|${c.port}|${c.username}`;
      const next = [cfg, ...prev.filter((c) => key(c) !== key(cfg))].slice(0, 20);
      localStorage.setItem("savedRemotes", JSON.stringify(next));
      return next;
    });
  };
  const closeTab = (id: string) => {
    // confirm so an accidental click on ✕ doesn't drop a running tab
    const tb = tabsRef.current.find((x) => x.id === id);
    if (tb && !confirm(STR[lang].closeConfirm(tb.title))) return;
    setTabs((ts) => {
      let rest = ts.filter((x) => x.id !== id);
      if (rest.length === 0) rest = [newTab(lang)];
      if (activeId === id) setActiveId(rest[0].id);
      return rest;
    });
  };
  const patchActive = (patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((tb) => (tb.id === activeTab.id ? { ...tb, ...patch } : tb)));

  const reorder = (targetId: string) => {
    const from = dragTab.current;
    dragTab.current = null;
    if (!from || from === targetId) return;
    setTabs((ts) => {
      const arr = [...ts];
      const fi = arr.findIndex((x) => x.id === from);
      const ti = arr.findIndex((x) => x.id === targetId);
      if (fi < 0 || ti < 0) return ts;
      const [moved] = arr.splice(fi, 1);
      arr.splice(ti, 0, moved);
      return arr;
    });
  };
  const commitRename = () => {
    const id = editingId;
    if (id) {
      const title = editDraft.trim();
      setTabs((ts) => ts.map((tb) => (tb.id === id ? { ...tb, title: title || tb.title } : tb)));
    }
    setEditingId(null);
  };

  const pickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t.pickTitle,
      defaultPath: activeTab?.cwd || undefined,
    });
    if (typeof selected === "string") patchActive({ cwd: selected });
  };
  // pick the folder for a specific tab (used by terminal tabs — restarts the
  // embedded claude in the chosen folder)
  const pickFolderForTab = async (id: string) => {
    const tab = tabs.find((x) => x.id === id);
    const selected = await open({
      directory: true,
      multiple: false,
      title: t.pickTitle,
      defaultPath: tab?.cwd || undefined,
    });
    if (typeof selected === "string")
      setTabs((ts) => ts.map((tb) => (tb.id === id ? { ...tb, cwd: selected } : tb)));
  };
  const openTerminal = () => invoke("open_terminal", { cwd: activeTab?.cwd || null }).catch(() => {});

  const exportMd = async () => {
    if (!activeTab) return;
    const md = activeTab.messages
      .filter((m) => m.kind !== "tool")
      .map((m) => (m.role === "user" ? "### 🧑\n\n" : "### ✳ Claude\n\n") + m.content)
      .join("\n\n---\n\n");
    const path = await save({
      defaultPath: `${activeTab.title}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (path) await invoke("write_text_file", { path, content: md }).catch(() => {});
  };

  const copyMsg = (content: string) => invoke("clipboard_set", { text: content }).catch(() => {});

  // --- send / stop ---
  const send = async () => {
    const text = input.trim();
    if (!text || busy || !activeTab) return;
    const reqId = crypto.randomUUID();
    reqToTab.current[reqId] = activeTab.id;
    tabReq.current[activeTab.id] = reqId;
    setInput("");
    setImgPreview(null);

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
        resume: activeTab.sessionId || null,
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
    patchActive({ messages: [], sessionId: undefined, usage: undefined });
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
          {activeTab?.kind === "chat" && (
            <button onClick={exportMd} title={t.exportMd}>
              ⬇
            </button>
          )}
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
            className={`tab tab-${tb.kind} ${tb.id === activeId ? "active" : ""}`}
            draggable
            onDragStart={() => (dragTab.current = tb.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => reorder(tb.id)}
            onClick={() => setActiveId(tb.id)}
            onDoubleClick={() => {
              setEditingId(tb.id);
              setEditDraft(tb.title);
            }}
            title={tb.title}
          >
            <span className="tab-ico">
              {tb.kind === "terminal"
                ? "🖥"
                : tb.kind === "git"
                  ? "⎇"
                  : tb.kind === "remote"
                    ? "🌐"
                    : "💬"}
            </span>
            {editingId === tb.id ? (
              <input
                className="tab-edit"
                autoFocus
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <span className="tab-title">{tb.title}</span>
            )}
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
        <button className="tab-add" onClick={() => addTerminalTab()} title={t.newTerm}>
          🖥
        </button>
        <button className="tab-add" onClick={() => addTerminalTab(["--resume"])} title={t.resume}>
          ↺
        </button>
        <button className="tab-add" onClick={addGitTab} title={t.newGit}>
          ⎇
        </button>
        <button className="tab-add" onClick={addRemoteTab} title={t.newRemote}>
          🌐
        </button>
      </div>

      {/* terminal tabs stay mounted (hidden when inactive) so they keep running */}
      {tabs
        .filter((tb) => tb.kind === "terminal")
        .map((tb) => (
          <div key={tb.id} className="term-wrap" style={{ display: tb.id === activeId ? "flex" : "none" }}>
            <div className="cwd-bar">
              <label>{t.folder}</label>
              <input
                type="text"
                placeholder={t.folderPick}
                value={tb.cwd || ""}
                readOnly
                onClick={() => pickFolderForTab(tb.id)}
                style={{ cursor: "pointer" }}
              />
              <button className="browse-btn" onClick={() => pickFolderForTab(tb.id)} title={t.choose}>
                📁
              </button>
              {tb.cwd && (
                <button
                  className="browse-btn"
                  onClick={() => setTabs((ts) => ts.map((x) => (x.id === tb.id ? { ...x, cwd: "" } : x)))}
                  title={t.clearField}
                >
                  ✕
                </button>
              )}
              <button
                className={`browse-btn auto-yes ${tb.skipPermissions ? "on" : ""}`}
                title={t.autoYesHint}
                onClick={() =>
                  setTabs((ts) =>
                    ts.map((x) => (x.id === tb.id ? { ...x, skipPermissions: !x.skipPermissions } : x))
                  )
                }
              >
                {tb.skipPermissions ? "✅" : "☑"} {t.autoYes}
              </button>
            </div>
            <TerminalView
              key={`${tb.cwd}|${tb.skipPermissions ? "y" : "n"}`}
              termId={tb.id}
              cwd={tb.cwd}
              fontSize={fontSize}
              extraArgs={[
                ...(tb.restored ? ["--continue"] : (tb as Tab & { _extra?: string[] })._extra ?? []),
                ...(tb.skipPermissions ? ["--dangerously-skip-permissions"] : []),
              ]}
            />
          </div>
        ))}

      {/* git tabs: folder bar + panel, scoped to the chosen project folder */}
      {tabs
        .filter((tb) => tb.kind === "git")
        .map((tb) => (
          <div key={tb.id} className="term-wrap" style={{ display: tb.id === activeId ? "flex" : "none" }}>
            <div className="cwd-bar">
              <label>{t.folder}</label>
              <input
                type="text"
                placeholder={t.folderPick}
                value={tb.cwd || ""}
                readOnly
                onClick={() => pickFolderForTab(tb.id)}
                style={{ cursor: "pointer" }}
              />
              <button className="browse-btn" onClick={() => pickFolderForTab(tb.id)} title={t.choose}>
                📁
              </button>
              {tb.cwd && (
                <button
                  className="browse-btn"
                  onClick={() => setTabs((ts) => ts.map((x) => (x.id === tb.id ? { ...x, cwd: "" } : x)))}
                  title={t.clearField}
                >
                  ✕
                </button>
              )}
            </div>
            <GitPanel key={tb.cwd} cwd={tb.cwd} lang={lang} />
          </div>
        ))}

      {/* remote (SFTP/FTP) tabs: stay mounted so the connection survives tab switches */}
      {tabs
        .filter((tb) => tb.kind === "remote")
        .map((tb) => (
          <div key={tb.id} className="term-wrap" style={{ display: tb.id === activeId ? "flex" : "none" }}>
            <RemotePanel
              connId={tb.id}
              config={tb.remote ?? newRemoteConfig()}
              saved={savedRemotes}
              lang={lang}
              onConfigChange={(c) => setTabRemote(tb.id, c)}
              onSaveConnection={saveRemote}
              onUseSaved={(c) => setTabRemote(tb.id, c)}
            />
          </div>
        ))}

      {activeTab?.kind === "chat" && (
        <>
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
              📁
            </button>
            <button className="browse-btn" onClick={openTerminal} title={t.terminal}>
              🖥
            </button>
            <button
              className={`browse-btn ${activeTab.split ? "on" : ""}`}
              onClick={() => patchActive({ split: !activeTab.split })}
              title={t.split}
            >
              ⊟
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
          </div>

          <div className={`chat-body ${activeTab.split ? "split" : ""}`}>
            <div className="chat-col">
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
                      {m.content && !m.streaming && (
                        <button className="copy-btn" onClick={() => copyMsg(m.content)} title={t.copy}>
                          ⧉
                        </button>
                      )}
                    </div>
                  )
                )}
              </div>

              {imgPreview && (
                <div className="img-preview">
                  <img src={convertFileSrc(imgPreview)} alt="" />
                  <span className="rm" onClick={() => setImgPreview(null)}>
                    ✕
                  </span>
                </div>
              )}

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
            </div>

            {activeTab.split && (
              <div className="split-term">
                <TerminalView termId={`${activeTab.id}:split`} cwd={activeTab.cwd} fontSize={fontSize} />
              </div>
            )}
          </div>
        </>
      )}

      <div className="statusbar">
        <span>{claudeVersion ? `claude ${claudeVersion}` : t.cliNotFound}</span>
        {activeTab?.kind === "chat" && activeTab.usage && (
          <span>
            ↑ {activeTab.usage.input.toLocaleString()} ↓ {activeTab.usage.output.toLocaleString()} {t.tokens}
          </span>
        )}
        <span className="sb-spacer" />
        {activeTab?.cwd && <span title={activeTab.cwd}>📁 {activeTab.cwd.split("/").pop()}</span>}
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

            <label style={{ marginTop: 14 }}>{t.theme}</label>
            <div className="lang-switch">
              <button className={theme === "dark" ? "active" : ""} onClick={() => setThemeState("dark")}>
                {t.dark}
              </button>
              <button className={theme === "light" ? "active" : ""} onClick={() => setThemeState("light")}>
                {t.light}
              </button>
            </div>

            <label style={{ marginTop: 14 }}>
              {t.fontSize}: {fontSize}px
            </label>
            <input
              type="range"
              min={11}
              max={20}
              value={fontSize}
              onChange={(e) => setFontSizeState(Number(e.target.value))}
              style={{ width: "100%" }}
            />

            <label style={{ marginTop: 14 }}>{t.proxy}</label>
            <div className="proxy-row">
              <input
                type="text"
                value={proxyDraft}
                onChange={(e) => setProxyDraft(e.target.value)}
                onBlur={saveProxy}
                placeholder="127.0.0.1:8080"
              />
              <button onClick={saveProxy} disabled={proxyDraft.trim() === settings.proxy}>
                {proxyDraft.trim() === settings.proxy ? t.proxySaved : t.proxySave}
              </button>
            </div>
            <p className="hint">{t.proxyHint}</p>

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
