import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { usePrompt, useConfirm } from "./usePrompt";

type Lang = "en" | "fa";

export interface RemoteConfig {
  protocol: "sftp" | "ftp" | "ftps";
  host: string;
  port: number;
  username: string;
  password?: string;
  key_path?: string;
  passphrase?: string;
  /** optional per-connection proxy, independent of the app proxy */
  proxy?: string;
}

interface RemoteFile {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

const S = {
  en: {
    protocol: "Protocol",
    host: "Host",
    port: "Port",
    user: "Username",
    password: "Password",
    key: "Private key",
    keyPick: "Choose key file…",
    passphrase: "Key passphrase",
    proxy: "Proxy (optional)",
    proxyPh: "socks5://127.0.0.1:1080 or 127.0.0.1:8080",
    proxyHint: "Separate from the app proxy. Empty = direct connection.",
    connect: "Connect",
    disconnect: "Disconnect",
    connecting: "Connecting…",
    save: "Save this connection",
    saved: "Saved connections",
    up: "Up",
    refresh: "Refresh",
    upload: "Upload…",
    newFolder: "New folder",
    download: "Download",
    rename: "Rename",
    del: "Delete",
    cancel: "Cancel",
    empty: "Empty folder",
    name: "Name",
    size: "Size",
    modified: "Modified",
    delConfirm: (n: string) => `Delete "${n}"?`,
    newFolderPrompt: "New folder name:",
    renamePrompt: "New name:",
    downloaded: "Downloaded",
    uploaded: "Uploaded",
    done: "Done",
    dir: "folder",
    fillHost: "Enter a host to connect.",
  },
  fa: {
    protocol: "پروتکل",
    host: "هاست",
    port: "پورت",
    user: "نام کاربری",
    password: "رمز عبور",
    key: "کلید خصوصی",
    keyPick: "انتخاب فایل کلید…",
    passphrase: "عبارت عبور کلید",
    proxy: "پروکسی (اختیاری)",
    proxyPh: "socks5://127.0.0.1:1080 یا 127.0.0.1:8080",
    proxyHint: "جدا از پروکسی برنامه. خالی = اتصال مستقیم.",
    connect: "اتصال",
    disconnect: "قطع",
    connecting: "در حال اتصال…",
    save: "ذخیره‌ی این اتصال",
    saved: "اتصال‌های ذخیره‌شده",
    up: "بالا",
    refresh: "تازه‌سازی",
    upload: "آپلود…",
    newFolder: "پوشه‌ی جدید",
    download: "دانلود",
    rename: "تغییر نام",
    del: "حذف",
    cancel: "انصراف",
    empty: "پوشه‌ی خالی",
    name: "نام",
    size: "اندازه",
    modified: "تغییر",
    delConfirm: (n: string) => `«${n}» حذف شود؟`,
    newFolderPrompt: "نام پوشه‌ی جدید:",
    renamePrompt: "نام جدید:",
    downloaded: "دانلود شد",
    uploaded: "آپلود شد",
    done: "انجام شد",
    dir: "پوشه",
    fillHost: "برای اتصال یک هاست وارد کن.",
  },
};

const DEFAULT_PORT = { sftp: 22, ftp: 21, ftps: 21 } as const;

function fmtSize(n: number, isDir: boolean): string {
  if (isDir) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function fmtTime(secs: number): string {
  if (!secs) return "";
  try {
    return new Date(secs * 1000).toLocaleString();
  } catch {
    return "";
  }
}
function parentPath(p: string): string {
  if (p === "/" || !p) return "/";
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
function baseName(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

export default function RemotePanel({
  connId,
  config,
  saved,
  lang,
  onConfigChange,
  onSaveConnection,
  onUseSaved,
}: {
  connId: string;
  config: RemoteConfig;
  saved: RemoteConfig[];
  lang: Lang;
  onConfigChange: (c: RemoteConfig) => void;
  onSaveConnection: (c: RemoteConfig) => void;
  onUseSaved: (c: RemoteConfig) => void;
}) {
  const t = S[lang];
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState("/");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const { ask, node: promptNode } = usePrompt();
  const { confirm, node: confirmNode } = useConfirm();

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  }, []);

  const set = (patch: Partial<RemoteConfig>) => onConfigChange({ ...config, ...patch });

  const listDir = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        const f = await invoke<RemoteFile[]>("remote_list", { connId, path });
        setFiles(f);
        setCwd(path);
      } catch (e) {
        flash(String(e));
      } finally {
        setBusy(false);
      }
    },
    [connId, flash]
  );

  const connect = async () => {
    if (!config.host.trim()) {
      flash(t.fillHost);
      return;
    }
    setBusy(true);
    try {
      const start = await invoke<string>("remote_connect", { connId, creds: config });
      setConnected(true);
      await listDir(start || "/");
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = useCallback(async () => {
    try {
      await invoke("remote_disconnect", { connId });
    } catch {
      /* ignore */
    }
    setConnected(false);
    setFiles([]);
    setCwd("/");
  }, [connId]);

  // disconnect when the tab/component unmounts
  useEffect(() => {
    return () => {
      invoke("remote_disconnect", { connId }).catch(() => {});
    };
  }, [connId]);

  const download = async (f: RemoteFile) => {
    const dest = await saveDialog({ defaultPath: f.name, title: t.download });
    if (typeof dest !== "string") return;
    setBusy(true);
    try {
      await invoke("remote_download", { connId, remotePath: f.path, localPath: dest });
      flash(`${t.downloaded}: ${f.name}`);
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    const src = await openDialog({ multiple: false, title: t.upload });
    if (typeof src !== "string") return;
    const name = baseName(src);
    setBusy(true);
    try {
      await invoke("remote_upload", { connId, localPath: src, remotePath: cwd === "/" ? `/${name}` : `${cwd}/${name}` });
      flash(`${t.uploaded}: ${name}`);
      await listDir(cwd);
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  const mkdir = async () => {
    const name = await ask(t.newFolderPrompt);
    if (!name || !name.trim()) return;
    setBusy(true);
    try {
      await invoke("remote_mkdir", { connId, path: cwd === "/" ? `/${name.trim()}` : `${cwd}/${name.trim()}` });
      await listDir(cwd);
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: RemoteFile) => {
    if (!(await confirm(t.delConfirm(f.name), { ok: t.del, cancel: t.cancel, danger: true }))) return;
    setBusy(true);
    try {
      await invoke("remote_delete", { connId, path: f.path, isDir: f.is_dir });
      await listDir(cwd);
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (f: RemoteFile) => {
    const name = await ask(t.renamePrompt, f.name);
    if (!name || !name.trim() || name === f.name) return;
    const to = parentPath(f.path) === "/" ? `/${name.trim()}` : `${parentPath(f.path)}/${name.trim()}`;
    setBusy(true);
    try {
      await invoke("remote_rename", { connId, from: f.path, to });
      await listDir(cwd);
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- not connected: the connection form ----
  if (!connected) {
    return (
      <div className="rmt-panel">
        <div className="rmt-form">
          {saved.length > 0 && (
            <div className="rmt-saved">
              <label>{t.saved}</label>
              <div className="rmt-saved-list">
                {saved.map((s, i) => (
                  <button key={i} className="rmt-chip" onClick={() => onUseSaved(s)}>
                    {s.protocol}://{s.username ? `${s.username}@` : ""}
                    {s.host}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rmt-row">
            <label>{t.protocol}</label>
            <select
              value={config.protocol}
              onChange={(e) => {
                const protocol = e.target.value as RemoteConfig["protocol"];
                set({ protocol, port: DEFAULT_PORT[protocol] });
              }}
            >
              <option value="sftp">SFTP</option>
              <option value="ftp">FTP</option>
              <option value="ftps">FTPS</option>
            </select>
          </div>
          <div className="rmt-row">
            <label>{t.host}</label>
            <input value={config.host} onChange={(e) => set({ host: e.target.value })} placeholder="example.com" />
            <label className="rmt-port-l">{t.port}</label>
            <input
              className="rmt-port"
              type="number"
              value={config.port}
              onChange={(e) => set({ port: Number(e.target.value) || DEFAULT_PORT[config.protocol] })}
            />
          </div>
          <div className="rmt-row">
            <label>{t.user}</label>
            <input value={config.username} onChange={(e) => set({ username: e.target.value })} />
          </div>
          <div className="rmt-row">
            <label>{t.password}</label>
            <input
              type="password"
              value={config.password ?? ""}
              onChange={(e) => set({ password: e.target.value })}
            />
          </div>
          {config.protocol === "sftp" && (
            <>
              <div className="rmt-row">
                <label>{t.key}</label>
                <input
                  value={config.key_path ?? ""}
                  readOnly
                  placeholder="~/.ssh/id_ed25519"
                  onClick={async () => {
                    const p = await openDialog({ multiple: false, title: t.keyPick });
                    if (typeof p === "string") set({ key_path: p });
                  }}
                  style={{ cursor: "pointer" }}
                />
                {config.key_path && (
                  <button className="rmt-btn" onClick={() => set({ key_path: "" })}>
                    ✕
                  </button>
                )}
              </div>
              <div className="rmt-row">
                <label>{t.passphrase}</label>
                <input
                  type="password"
                  value={config.passphrase ?? ""}
                  onChange={(e) => set({ passphrase: e.target.value })}
                />
              </div>
            </>
          )}

          <div className="rmt-row">
            <label>{t.proxy}</label>
            <input value={config.proxy ?? ""} onChange={(e) => set({ proxy: e.target.value })} placeholder={t.proxyPh} />
          </div>
          <p className="hint" style={{ margin: "2px 0 0" }}>
            {t.proxyHint}
          </p>

          <div className="rmt-actions">
            <button className="rmt-btn primary" disabled={busy} onClick={connect}>
              {busy ? t.connecting : `🔌 ${t.connect}`}
            </button>
            <button className="rmt-btn" disabled={busy} onClick={() => onSaveConnection(config)}>
              💾 {t.save}
            </button>
          </div>
        </div>
        {toast && (
          <div className="rmt-toast" onClick={() => setToast(null)}>
            {toast}
          </div>
        )}
      </div>
    );
  }

  // ---- connected: the file browser ----
  return (
    <div className="rmt-panel">
      <div className="rmt-bar">
        <button className="rmt-btn" disabled={busy || cwd === "/"} onClick={() => listDir(parentPath(cwd))} title={t.up}>
          ⬆
        </button>
        <button className="rmt-btn" disabled={busy} onClick={() => listDir(cwd)} title={t.refresh}>
          ↻
        </button>
        <span className="rmt-path" title={cwd}>
          {cwd}
        </span>
        <span className="rmt-spacer" />
        <button className="rmt-btn" disabled={busy} onClick={upload}>
          ⬆ {t.upload}
        </button>
        <button className="rmt-btn" disabled={busy} onClick={mkdir}>
          📁＋
        </button>
        <button className="rmt-btn danger" disabled={busy} onClick={disconnect}>
          {t.disconnect}
        </button>
      </div>

      <div className="rmt-list">
        <div className="rmt-head">
          <span>{t.name}</span>
          <span>{t.size}</span>
          <span>{t.modified}</span>
          <span />
        </div>
        {files.map((f) => (
          <div
            key={f.path}
            className="rmt-file"
            onDoubleClick={() => f.is_dir && listDir(f.path)}
          >
            <span className="rmt-fname" onClick={() => f.is_dir && listDir(f.path)} style={{ cursor: f.is_dir ? "pointer" : "default" }}>
              {f.is_dir ? "📁" : "📄"} {f.name}
            </span>
            <span className="rmt-fsize">{fmtSize(f.size, f.is_dir)}</span>
            <span className="rmt-ftime">{fmtTime(f.modified)}</span>
            <span className="rmt-fact">
              {!f.is_dir && (
                <button className="rmt-mini" title={t.download} onClick={() => download(f)}>
                  ⬇
                </button>
              )}
              <button className="rmt-mini" title={t.rename} onClick={() => rename(f)}>
                ✎
              </button>
              <button className="rmt-mini" title={t.del} onClick={() => remove(f)}>
                🗑
              </button>
            </span>
          </div>
        ))}
        {files.length === 0 && !busy && <div className="rmt-empty">{t.empty}</div>}
      </div>

      {toast && (
        <div className="rmt-toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
      {promptNode}
      {confirmNode}
    </div>
  );
}
