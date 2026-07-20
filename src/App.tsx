import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import "highlight.js/styles/github-dark.css";
import TerminalView, { TERM_FONTS } from "./Terminal";
import GitPanel from "./GitPanel";
import RemotePanel, { type RemoteConfig } from "./RemotePanel";
import SshPanel, { type SshConfig } from "./SshPanel";
import { useConfirm } from "./usePrompt";
import ChatView from "./components/ChatView";
import CwdBar from "./components/CwdBar";
import SettingsModal from "./components/SettingsModal";
import TabStrip from "./components/TabStrip";
import { APP_STR as STR, type Lang } from "./i18n";
import { quotePath, isImage } from "./utils";
import type { Message, Tab, TabKind, Theme, Usage } from "./types";
import "./App.css";

interface Settings {
  lang: Lang;
  proxy: string;
}

// ---- OS-keyring keys for connection secrets (passwords never touch disk) ----
const sshSecretKey = (c: SshConfig) => `ssh:${c.username}@${c.host}:${c.port}`;
const remoteSecretKey = (c: RemoteConfig) => `${c.protocol}:${c.username}@${c.host}:${c.port}`;

/** Merge an SSH config's password back in from the keyring (no-op if absent). */
async function withSshSecret(c: SshConfig): Promise<SshConfig> {
  if (!c.host || c.password) return c;
  try {
    const pw = await invoke<string | null>("secret_get", { key: sshSecretKey(c) });
    return pw ? { ...c, password: pw } : c;
  } catch {
    return c;
  }
}

/** Merge an SFTP/FTP config's password+passphrase back in from the keyring. */
async function withRemoteSecret(c: RemoteConfig): Promise<RemoteConfig> {
  if (!c.host || c.password || c.passphrase) return c;
  try {
    const raw = await invoke<string | null>("secret_get", { key: remoteSecretKey(c) });
    if (!raw) return c;
    const s = JSON.parse(raw) as { password?: string; passphrase?: string };
    return { ...c, password: s.password ?? "", passphrase: s.passphrase ?? "" };
  } catch {
    return c;
  }
}

/** Appended to terminal claude launches when "Terminal replies in English" is
 *  on: xterm.js has no BiDi, so right-to-left answers render scrambled. */
/* Wording matters: a politely-phrased version of this was simply ignored —
 * matching the user's language outweighs a soft request. The hard framing
 * below was verified to actually switch the replies to English. */
const TERM_ENGLISH_PROMPT =
  "CRITICAL OUTPUT CONSTRAINT: Your replies MUST be written in English only. " +
  "This session runs in a terminal that cannot render right-to-left script — " +
  "Persian/Arabic text appears scrambled and unreadable there. Never reply in " +
  "Persian, regardless of the language the user writes in. Do not translate " +
  "code, file paths, commands, or identifiers.";

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
          : kind === "ssh"
            ? STR[lang].tabSsh(n)
            : STR[lang].tab(n);
  return {
    id: crypto.randomUUID(),
    kind,
    title,
    messages: [],
    cwd,
    permission: "default",
    ...(kind === "remote" ? { remote: newRemoteConfig() } : {}),
    ...(kind === "ssh" ? { ssh: newSshConfig() } : {}),
    ...(kind === "terminal" ? { termSession: crypto.randomUUID() } : {}),
  };
}

function newRemoteConfig(): RemoteConfig {
  return {
    protocol: "sftp",
    name: "",
    host: "",
    port: 22,
    username: "",
    password: "",
    key_path: "",
    passphrase: "",
    proxy: "",
    local_path: "",
  };
}

function newSshConfig(): SshConfig {
  return { name: "", host: "", port: 22, username: "", password: "", key_path: "", proxy: "" };
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

  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "dark");
  const [fontSize, setFontSizeState] = useState<number>(() => Number(localStorage.getItem("fontSize")) || 14);
  // terminal font (id from TERM_FONTS) — persisted like theme/font size
  const [termFontId, setTermFontId] = useState<string>(() => localStorage.getItem("termFont") || "default");
  const termFont = (TERM_FONTS.find((f) => f.id === termFontId) ?? TERM_FONTS[0]).stack;
  // ask claude to answer in English in terminal tabs (xterm has no BiDi, so
  // Persian answers render scrambled there); chat tabs are unaffected
  const [termEnglish, setTermEnglish] = useState<boolean>(() => localStorage.getItem("termEnglish") === "1");
  // run claude in screen-reader mode: flat line output, no drawn boxes, no
  // alternate screen — which also restores real scrollback
  const [termFlat, setTermFlat] = useState<boolean>(() => localStorage.getItem("termFlat") === "1");

  const [showSettings, setShowSettings] = useState(false);
  // saved SFTP/FTP connections (persisted locally; may include passwords)
  const [savedRemotes, setSavedRemotes] = useState<RemoteConfig[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("savedRemotes") || "[]");
    } catch {
      return [];
    }
  });
  // saved SSH servers (persisted locally; may include passwords)
  const [savedSsh, setSavedSsh] = useState<SshConfig[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("savedSshServers") || "[]");
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
  const [appVersion, setAppVersion] = useState<string>("");
  const { confirm: askConfirm, node: confirmNode } = useConfirm();

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
  const askConfirmRef = useRef(askConfirm);
  askConfirmRef.current = askConfirm;
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
    localStorage.setItem("termFont", termFontId);
  }, [termFontId]);
  useEffect(() => {
    localStorage.setItem("termEnglish", termEnglish ? "1" : "0");
  }, [termEnglish]);
  useEffect(() => {
    localStorage.setItem("termFlat", termFlat ? "1" : "0");
  }, [termFlat]);

  useEffect(() => {
    invoke<Settings>("load_settings").then((s) => {
      setSettings({ lang: (s.lang as Lang) || "en", proxy: s.proxy || "" });
      setProxyDraft(s.proxy || "");
    });
    invoke<string | null>("claude_check").then(setClaudeVersion);
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
    isPermissionGranted().then((g) => {
      if (!g) requestPermission();
    });
    invoke<string>("load_session")
      .then((raw) => {
        if (raw) {
          const data = JSON.parse(raw);
          if (Array.isArray(data.tabs) && data.tabs.length) {
            const restored: Tab[] = data.tabs.map((tb: Tab) => ({
              ...tb,
              kind: tb.kind ?? "chat",
              permission: tb.permission ?? "default",
              restored: tb.kind === "terminal" ? true : undefined,
            }));
            setTabs(restored);
            if (data.activeId) setActiveId(data.activeId);
            if (typeof data.counter === "number") tabCounter = data.counter;
            // session.json never contains secrets — re-attach passwords for the
            // restored connection drafts from the OS keyring, asynchronously
            Promise.all(
              restored.map(async (tb) => {
                if (tb.kind === "ssh" && tb.ssh) return { ...tb, ssh: await withSshSecret(tb.ssh) };
                if (tb.kind === "remote" && tb.remote)
                  return { ...tb, remote: await withRemoteSecret(tb.remote) };
                return tb;
              })
            )
              .then(setTabs)
              .catch(() => {});
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
      });
  }, []);

  // one-time migration: move plaintext passwords saved by pre-keyring versions
  // out of localStorage into the OS keyring
  useEffect(() => {
    (async () => {
      let sshChanged = false;
      const ssh = await Promise.all(
        savedSsh.map(async (c) => {
          if (!c.password) return c;
          try {
            await invoke("secret_set", { key: sshSecretKey(c), value: c.password });
            sshChanged = true;
            return { ...c, password: "" };
          } catch {
            return c;
          }
        })
      );
      if (sshChanged) {
        setSavedSsh(ssh);
        localStorage.setItem("savedSshServers", JSON.stringify(ssh));
      }
      let rmtChanged = false;
      const rmt = await Promise.all(
        savedRemotes.map(async (c) => {
          if (!c.password && !c.passphrase) return c;
          try {
            await invoke("secret_set", {
              key: remoteSecretKey(c),
              value: JSON.stringify({ password: c.password ?? "", passphrase: c.passphrase ?? "" }),
            });
            rmtChanged = true;
            return { ...c, password: "", passphrase: "" };
          } catch {
            return c;
          }
        })
      );
      if (rmtChanged) {
        setSavedRemotes(rmt);
        localStorage.setItem("savedRemotes", JSON.stringify(rmt));
      }
    })();
    // runs once against the values loaded from localStorage at startup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // auto-save (disk → survives app & system restart)
  useEffect(() => {
    if (!loaded.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const sanitized = tabs.map((tb) => {
        const { restored: _r, ...rest } = tb;
        return {
          ...rest,
          // connection secrets live in the OS keyring, never in session.json
          ...(rest.ssh ? { ssh: { ...rest.ssh, password: "" } } : {}),
          ...(rest.remote ? { remote: { ...rest.remote, password: "", passphrase: "" } } : {}),
          messages: tb.messages.map((m) => ({ ...m, streaming: false })),
        };
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
    u.push(
      listen("code://delta", (e: { payload: StreamPayload }) => appendDelta(e.payload.id, e.payload.text))
    );
    u.push(
      listen("code://tool", (e: { payload: StreamPayload }) => appendTool(e.payload.id, e.payload.text))
    );
    u.push(
      listen("code://session", (e: { payload: SessionPayload }) =>
        setSession(e.payload.id, e.payload.session_id)
      )
    );
    u.push(
      listen("code://usage", (e: { payload: UsagePayload }) =>
        setUsage(e.payload.id, { input: e.payload.input, output: e.payload.output })
      )
    );
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
          e.payload.message === "NOT_LOGGED_IN"
            ? "\n\n" + tRef.current.notLoggedIn
            : "\n\n⚠️ " + e.payload.message
        )
      )
    );
    return () => u.forEach((p) => p.then((f) => f()));
  }, [appendDelta, appendTool, setSession, setUsage, finishReq]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [tabs, activeId]);

  useEffect(() => {
    getCurrentWindow()
      .setTitle(t.brand)
      .catch(() => {});
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
        } else if (activeRef.current.kind === "remote") {
          // files dropped from the OS onto an SFTP/FTP tab → upload them there
          window.dispatchEvent(
            new CustomEvent("remote-os-drop", { detail: { tabId: activeRef.current.id, paths: raw } })
          );
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

  // Block pasting image clipboard content into the DOM — webkit2gtk (the Linux
  // webview) frequently crashes when an image is pasted (e.g. Ctrl+Shift+V after
  // copying a screenshot). Text paste is unaffected. Capture phase so it runs
  // before any input's own handler.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          e.preventDefault();
          return;
        }
      }
    };
    document.addEventListener("paste", onPaste, true);
    return () => document.removeEventListener("paste", onPaste, true);
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
        const tb = ts.find((x) => x.id === id);
        const doClose = () =>
          setTabs((p) => {
            let rest = p.filter((x) => x.id !== id);
            if (rest.length === 0) rest = [newTab(langRef.current)];
            setActiveId(rest[Math.max(0, Math.min(idx, rest.length - 1))].id);
            return rest;
          });
        if (tb)
          askConfirmRef.current(STR[langRef.current].closeConfirm(tb.title)).then((ok) => {
            if (ok) doClose();
          });
        else doClose();
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
    // session-picker tabs attach to an externally chosen session, so they don't
    // own a dedicated --session-id of their own
    if (extra) {
      (tb as Tab & { _extra?: string[] })._extra = extra;
      delete tb.termSession;
    }
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
  const remoteKey = (c: RemoteConfig) => `${c.protocol}|${c.host}|${c.port}|${c.username}`;
  const saveRemote = async (cfg: RemoteConfig) => {
    let toStore = cfg;
    if (cfg.password || cfg.passphrase) {
      try {
        // secrets go to the OS keyring; the chip list keeps only the address
        await invoke("secret_set", {
          key: remoteSecretKey(cfg),
          value: JSON.stringify({ password: cfg.password ?? "", passphrase: cfg.passphrase ?? "" }),
        });
        toStore = { ...cfg, password: "", passphrase: "" };
      } catch {
        /* keyring unavailable — fall back to the pre-keyring behavior */
      }
    }
    setSavedRemotes((prev) => {
      // de-dupe by protocol/host/user; password is not stored in the chip key
      const next = [toStore, ...prev.filter((c) => remoteKey(c) !== remoteKey(cfg))].slice(0, 20);
      localStorage.setItem("savedRemotes", JSON.stringify(next));
      return next;
    });
  };
  const deleteRemote = (cfg: RemoteConfig) => {
    invoke("secret_delete", { key: remoteSecretKey(cfg) }).catch(() => {});
    setSavedRemotes((prev) => {
      const next = prev.filter((c) => remoteKey(c) !== remoteKey(cfg));
      localStorage.setItem("savedRemotes", JSON.stringify(next));
      return next;
    });
  };
  const addSshTab = () => {
    const tb = newTab(lang, "ssh");
    setTabs((ts) => [...ts, tb]);
    setActiveId(tb.id);
  };
  const setTabSsh = (id: string, ssh: SshConfig) =>
    setTabs((ts) => ts.map((tb) => (tb.id === id ? { ...tb, ssh } : tb)));
  const sshKey = (c: SshConfig) => `${c.host}|${c.port}|${c.username}`;
  const saveSshServer = async (cfg: SshConfig) => {
    if (!cfg.host.trim()) return;
    let toStore = cfg;
    if (cfg.password) {
      try {
        await invoke("secret_set", { key: sshSecretKey(cfg), value: cfg.password });
        toStore = { ...cfg, password: "" };
      } catch {
        /* keyring unavailable — fall back to the pre-keyring behavior */
      }
    }
    setSavedSsh((prev) => {
      const next = [toStore, ...prev.filter((c) => sshKey(c) !== sshKey(cfg))].slice(0, 20);
      localStorage.setItem("savedSshServers", JSON.stringify(next));
      return next;
    });
  };
  const deleteSshServer = (cfg: SshConfig) => {
    invoke("secret_delete", { key: sshSecretKey(cfg) }).catch(() => {});
    setSavedSsh((prev) => {
      const next = prev.filter((c) => sshKey(c) !== sshKey(cfg));
      localStorage.setItem("savedSshServers", JSON.stringify(next));
      return next;
    });
  };
  const closeTab = async (id: string) => {
    // confirm so an accidental click on ✕ doesn't drop a running tab (themed
    // modal — window.confirm() is ignored under WebKitGTK)
    const tb = tabsRef.current.find((x) => x.id === id);
    if (tb && !(await askConfirm(STR[lang].closeConfirm(tb.title)))) return;
    setTabs((ts) => {
      let rest = ts.filter((x) => x.id !== id);
      if (rest.length === 0) rest = [newTab(lang)];
      if (activeId === id) setActiveId(rest[0].id);
      return rest;
    });
  };
  const patchActive = (patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((tb) => (tb.id === activeTab.id ? { ...tb, ...patch } : tb)));

  const reorderLive = (fromId: string, overId: string) =>
    setTabs((ts) => {
      const arr = [...ts];
      const fi = arr.findIndex((x) => x.id === fromId);
      const ti = arr.findIndex((x) => x.id === overId);
      if (fi < 0 || ti < 0 || fi === ti) return ts;
      const [moved] = arr.splice(fi, 1);
      arr.splice(ti, 0, moved);
      return arr;
    });
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
          ? {
              ...tb,
              title: isFirst ? text.slice(0, 22) : tb.title,
              messages: [...tb.messages, userMsg, placeholder],
            }
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

      <TabStrip
        tabs={tabs}
        activeId={activeId}
        lang={lang}
        onSelect={setActiveId}
        onClose={closeTab}
        onRename={(id, title) =>
          setTabs((ts) => ts.map((tb) => (tb.id === id ? { ...tb, title: title || tb.title } : tb)))
        }
        onReorder={reorderLive}
        onAddChat={addTab}
        onAddTerminal={addTerminalTab}
        onAddGit={addGitTab}
        onAddRemote={addRemoteTab}
        onAddSsh={addSshTab}
      />

      {/* terminal tabs stay mounted (hidden when inactive) so they keep running */}
      {tabs
        .filter((tb) => tb.kind === "terminal")
        .map((tb) => {
          const extra = (tb as Tab & { _extra?: string[] })._extra;
          // Tabs with a dedicated session id let the backend choose --resume vs
          // --session-id by whether that session exists for the current folder.
          // Picker tabs (--resume) and legacy tabs (no id → --continue on restart)
          // keep their explicit flags.
          const legacyArgs = tb.termSession ? [] : tb.restored ? ["--continue"] : (extra ?? []);
          return (
            <div key={tb.id} className="term-wrap" style={{ display: tb.id === activeId ? "flex" : "none" }}>
              <CwdBar
                cwd={tb.cwd}
                label={t.folder}
                placeholder={t.folderPick}
                chooseTitle={t.choose}
                clearTitle={t.clearField}
                onPick={() => pickFolderForTab(tb.id)}
                onClear={() => setTabs((ts) => ts.map((x) => (x.id === tb.id ? { ...x, cwd: "" } : x)))}
              >
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
              </CwdBar>
              <TerminalView
                key={`${tb.cwd}|${tb.skipPermissions ? "y" : "n"}|${termEnglish ? "en" : "any"}|${termFlat ? "flat" : "tui"}`}
                termId={tb.id}
                cwd={tb.cwd}
                claudeSession={tb.termSession}
                fontSize={fontSize}
                fontFamily={termFont}
                readableLabels={{ open: t.readable, back: t.readableBack, empty: t.readableEmpty }}
                extraArgs={[
                  ...legacyArgs,
                  ...(tb.skipPermissions ? ["--dangerously-skip-permissions"] : []),
                  ...(termEnglish ? ["--append-system-prompt", TERM_ENGLISH_PROMPT] : []),
                  ...(termFlat ? ["--ax-screen-reader"] : []),
                ]}
              />
            </div>
          );
        })}

      {/* git tabs: folder bar + panel, scoped to the chosen project folder */}
      {tabs
        .filter((tb) => tb.kind === "git")
        .map((tb) => (
          <div key={tb.id} className="term-wrap" style={{ display: tb.id === activeId ? "flex" : "none" }}>
            <CwdBar
              cwd={tb.cwd}
              label={t.folder}
              placeholder={t.folderPick}
              chooseTitle={t.choose}
              clearTitle={t.clearField}
              onPick={() => pickFolderForTab(tb.id)}
              onClear={() => setTabs((ts) => ts.map((x) => (x.id === tb.id ? { ...x, cwd: "" } : x)))}
            >
              <label className="git-proxy-l" title={t.gitProxyHint}>
                🌐
              </label>
              <input
                className="git-proxy-in"
                type="text"
                placeholder={t.gitProxy}
                title={t.gitProxyHint}
                value={tb.gitProxy ?? ""}
                onChange={(e) =>
                  setTabs((ts) => ts.map((x) => (x.id === tb.id ? { ...x, gitProxy: e.target.value } : x)))
                }
              />
            </CwdBar>
            <GitPanel key={tb.cwd} cwd={tb.cwd} lang={lang} proxy={tb.gitProxy || ""} />
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
              onDeleteConnection={deleteRemote}
              onUseSaved={(c) => withRemoteSecret(c).then((full) => setTabRemote(tb.id, full))}
            />
          </div>
        ))}

      {/* ssh tabs: stay mounted so the shell session survives tab switches */}
      {tabs
        .filter((tb) => tb.kind === "ssh")
        .map((tb) => (
          <div key={tb.id} className="term-wrap" style={{ display: tb.id === activeId ? "flex" : "none" }}>
            <SshPanel
              connId={tb.id}
              config={tb.ssh ?? newSshConfig()}
              saved={savedSsh}
              lang={lang}
              fontSize={fontSize}
              fontFamily={termFont}
              onConfigChange={(c) => setTabSsh(tb.id, c)}
              onSaveConnection={saveSshServer}
              onDeleteConnection={deleteSshServer}
              onUseSaved={(c) => withSshSecret(c).then((full) => setTabSsh(tb.id, full))}
            />
          </div>
        ))}

      {activeTab?.kind === "chat" && (
        <ChatView
          tab={activeTab}
          lang={lang}
          fontSize={fontSize}
          termFont={termFont}
          input={input}
          imgPreview={imgPreview}
          busy={busy}
          scrollRef={scrollRef}
          onInputChange={setInput}
          onSend={send}
          onStop={stop}
          onPickFolder={pickFolder}
          onOpenTerminal={openTerminal}
          onPatchTab={patchActive}
          onCopyMsg={copyMsg}
          onClearImgPreview={() => setImgPreview(null)}
        />
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
        <SettingsModal
          lang={lang}
          theme={theme}
          fontSize={fontSize}
          termFontId={termFontId}
          termEnglish={termEnglish}
          termFlat={termFlat}
          proxyDraft={proxyDraft}
          savedProxy={settings.proxy}
          appVersion={appVersion}
          onClose={() => setShowSettings(false)}
          onSetLang={setLang}
          onSetTheme={setThemeState}
          onSetFontSize={setFontSizeState}
          onSetTermFont={setTermFontId}
          onSetTermEnglish={setTermEnglish}
          onSetTermFlat={setTermFlat}
          onProxyDraftChange={setProxyDraft}
          onSaveProxy={saveProxy}
        />
      )}

      {confirmNode}
    </div>
  );
}

export default App;
