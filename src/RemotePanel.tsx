import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { usePrompt, useConfirm } from "./usePrompt";

type Lang = "en" | "fa";

export interface RemoteConfig {
  protocol: "sftp" | "ftp" | "ftps";
  /** optional friendly name shown on the saved-connection chip */
  name?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  key_path?: string;
  passphrase?: string;
  /** optional per-connection proxy, independent of the app proxy */
  proxy?: string;
  /** optional local project folder shown in the left pane (empty = home) */
  local_path?: string;
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
    namePh: "My server",
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
    localFolder: "Local folder",
    localFolderPh: "Click to choose… (empty = home folder)",
    localPane: "Local",
    remotePane: "Server",
    uploadThis: "Upload to server",
    noDirDrag: "Dragging folders isn't supported yet — files only.",
    dragHint: "Drag files between the two panes to upload / download.",
  },
  fa: {
    namePh: "سرور من",
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
    localFolder: "پوشه‌ی لوکال",
    localFolderPh: "برای انتخاب کلیک کن… (خالی = پوشه‌ی خانه)",
    localPane: "لوکال",
    remotePane: "سرور",
    uploadThis: "آپلود به سرور",
    noDirDrag: "کشیدن پوشه هنوز پشتیبانی نمی‌شود — فقط فایل.",
    dragHint: "فایل‌ها را بین دو سمت بکش تا آپلود / دانلود شوند.",
  },
};

const DEFAULT_PORT = { sftp: 22, ftp: 21, ftps: 21 } as const;

// the label on a saved chip: the friendly name if set, else protocol://user@host
function label(c: RemoteConfig): string {
  return c.name?.trim() || `${c.protocol}://${c.username ? `${c.username}@` : ""}${c.host}`;
}

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
  onDeleteConnection,
  onUseSaved,
}: {
  connId: string;
  config: RemoteConfig;
  saved: RemoteConfig[];
  lang: Lang;
  onConfigChange: (c: RemoteConfig) => void;
  onSaveConnection: (c: RemoteConfig) => void;
  onDeleteConnection: (c: RemoteConfig) => void;
  onUseSaved: (c: RemoteConfig) => void;
}) {
  const t = S[lang];
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState("/");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  // left pane: the local file browser
  const [localCwd, setLocalCwd] = useState("");
  const [localFiles, setLocalFiles] = useState<RemoteFile[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  // pointer-driven drag between the two panes (HTML5 DnD is swallowed by
  // Tauri's native file drag-drop handler on webkit, same as tab reordering)
  const dragRef = useRef<{
    source: "local" | "remote";
    file: RemoteFile;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const dropRef = useRef<"local" | "remote" | null>(null);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<"local" | "remote" | null>(null);
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

  const listLocal = useCallback(
    async (path?: string) => {
      try {
        const r = await invoke<{ path: string; files: RemoteFile[] }>("local_list", {
          path: path ?? null,
        });
        setLocalFiles(r.files);
        setLocalCwd(r.path);
      } catch (e) {
        flash(String(e));
      }
    },
    [flash]
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
      // left pane: the chosen local project folder, else the home folder
      await listLocal(config.local_path?.trim() || undefined);
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
      await invoke("remote_upload", {
        connId,
        localPath: src,
        remotePath: cwd === "/" ? `/${name}` : `${cwd}/${name}`,
      });
      flash(`${t.uploaded}: ${name}`);
      await listDir(cwd);
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  // upload a specific local file into the current remote folder (drag & drop /
  // row button / OS file drop)
  const uploadLocalFile = useCallback(
    async (localPath: string, name: string) => {
      setBusy(true);
      try {
        await invoke("remote_upload", {
          connId,
          localPath,
          remotePath: cwd === "/" ? `/${name}` : `${cwd}/${name}`,
        });
        flash(`${t.uploaded}: ${name}`);
        const f = await invoke<RemoteFile[]>("remote_list", { connId, path: cwd });
        setFiles(f);
      } catch (e) {
        flash(String(e));
      } finally {
        setBusy(false);
      }
    },
    [connId, cwd, flash, t.uploaded]
  );

  // download a remote file straight into the current local folder (drag & drop)
  const downloadToLocal = async (f: RemoteFile) => {
    setBusy(true);
    try {
      const dest = localCwd.endsWith("/") ? `${localCwd}${f.name}` : `${localCwd}/${f.name}`;
      await invoke("remote_download", { connId, remotePath: f.path, localPath: dest });
      flash(`${t.downloaded}: ${f.name}`);
      await listLocal(localCwd);
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  // files dropped from the OS file manager onto this tab → upload to remote cwd
  useEffect(() => {
    const onOsDrop = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId: string; paths: string[] }>).detail;
      if (!connected || detail.tabId !== connId) return;
      (async () => {
        for (const p of detail.paths) await uploadLocalFile(p, baseName(p));
      })();
    };
    window.addEventListener("remote-os-drop", onOsDrop);
    return () => window.removeEventListener("remote-os-drop", onOsDrop);
  }, [connected, connId, uploadLocalFile]);

  // ---- pointer-driven drag between panes ----
  const onRowPointerDown = (e: React.PointerEvent, source: "local" | "remote", f: RemoteFile) => {
    if (e.button !== 0) return;
    dragRef.current = { source, file: f, startX: e.clientX, startY: e.clientY, active: false };
  };
  const onRowPointerMove = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st) return;
    if (!st.active) {
      if (Math.abs(e.clientX - st.startX) < 6 && Math.abs(e.clientY - st.startY) < 6) return;
      st.active = true;
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    setDragGhost({
      x: e.clientX,
      y: e.clientY,
      label: `${st.file.is_dir ? "📁" : "📄"} ${st.file.name}`,
    });
    const pane = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest("[data-pane]");
    const p = (pane?.getAttribute("data-pane") ?? null) as "local" | "remote" | null;
    const tgt = p && p !== st.source ? p : null;
    dropRef.current = tgt;
    setDropTarget(tgt);
  };
  const onRowPointerUp = () => {
    const st = dragRef.current;
    const tgt = dropRef.current;
    dragRef.current = null;
    dropRef.current = null;
    setDragGhost(null);
    setDropTarget(null);
    if (!st?.active || !tgt || tgt === st.source) return;
    if (st.file.is_dir) {
      flash(t.noDirDrag);
      return;
    }
    if (st.source === "local" && tgt === "remote") uploadLocalFile(st.file.path, st.file.name);
    else if (st.source === "remote" && tgt === "local") downloadToLocal(st.file);
  };

  const mkdir = async () => {
    const name = await ask(t.newFolderPrompt);
    if (!name || !name.trim()) return;
    setBusy(true);
    try {
      await invoke("remote_mkdir", {
        connId,
        path: cwd === "/" ? `/${name.trim()}` : `${cwd}/${name.trim()}`,
      });
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
                  <span key={i} className="rmt-chip-wrap">
                    <button
                      className="rmt-chip"
                      onClick={() => onUseSaved(s)}
                      title={`${s.protocol}://${s.username ? `${s.username}@` : ""}${s.host}`}
                    >
                      🌐 {label(s)}
                    </button>
                    <button
                      className="rmt-chip-del"
                      title={t.del}
                      onClick={async () => {
                        if (
                          await confirm(t.delConfirm(label(s)), {
                            ok: t.del,
                            cancel: t.cancel,
                            danger: true,
                          })
                        )
                          onDeleteConnection(s);
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="rmt-row">
            <label>{t.name}</label>
            <input
              value={config.name ?? ""}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={t.namePh}
            />
          </div>
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
            <input
              value={config.host}
              onChange={(e) => set({ host: e.target.value })}
              placeholder="example.com"
            />
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
            <label>{t.localFolder}</label>
            <input
              value={config.local_path ?? ""}
              readOnly
              placeholder={t.localFolderPh}
              onClick={async () => {
                const p = await openDialog({ directory: true, multiple: false, title: t.localFolder });
                if (typeof p === "string") set({ local_path: p });
              }}
              style={{ cursor: "pointer" }}
            />
            {config.local_path && (
              <button className="rmt-btn" onClick={() => set({ local_path: "" })}>
                ✕
              </button>
            )}
          </div>
          <div className="rmt-row">
            <label>{t.proxy}</label>
            <input
              value={config.proxy ?? ""}
              onChange={(e) => set({ proxy: e.target.value })}
              placeholder={t.proxyPh}
            />
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

  // ---- connected: dual-pane browser — local project on the left, server on
  // the right; drag files between the panes to upload / download ----
  const fileRow = (f: RemoteFile, source: "local" | "remote") => {
    const enter = () => f.is_dir && (source === "local" ? listLocal(f.path) : listDir(f.path));
    return (
      <div
        key={f.path}
        className="rmt-file"
        onPointerDown={(e) => onRowPointerDown(e, source, f)}
        onPointerMove={onRowPointerMove}
        onPointerUp={onRowPointerUp}
        onDoubleClick={enter}
      >
        <span className="rmt-fname" onClick={enter} style={{ cursor: f.is_dir ? "pointer" : "default" }}>
          {f.is_dir ? "📁" : "📄"} {f.name}
        </span>
        <span className="rmt-fsize">{fmtSize(f.size, f.is_dir)}</span>
        <span className="rmt-ftime">{fmtTime(f.modified)}</span>
        <span className="rmt-fact">
          {source === "remote" ? (
            <>
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
            </>
          ) : (
            !f.is_dir && (
              <button
                className="rmt-mini"
                title={t.uploadThis}
                onClick={() => uploadLocalFile(f.path, f.name)}
              >
                ⬆
              </button>
            )
          )}
        </span>
      </div>
    );
  };

  const listHead = (
    <div className="rmt-head">
      <span>{t.name}</span>
      <span>{t.size}</span>
      <span>{t.modified}</span>
      <span />
    </div>
  );

  return (
    <div className="rmt-panel">
      <div className="rmt-split" dir="ltr">
        {/* left: local files */}
        <div className={`rmt-pane ${dropTarget === "local" ? "drop" : ""}`} data-pane="local">
          <div className="rmt-bar">
            <span className="rmt-pane-title">📁 {t.localPane}</span>
            <button
              className="rmt-btn"
              disabled={localCwd === "/"}
              onClick={() => listLocal(parentPath(localCwd))}
              title={t.up}
            >
              ⬆
            </button>
            <button className="rmt-btn" onClick={() => listLocal(localCwd)} title={t.refresh}>
              ↻
            </button>
            <span className="rmt-path" title={localCwd}>
              {localCwd}
            </span>
          </div>
          <div className="rmt-list">
            {listHead}
            {localFiles.map((f) => fileRow(f, "local"))}
            {localFiles.length === 0 && <div className="rmt-empty">{t.empty}</div>}
          </div>
        </div>

        {/* right: the server */}
        <div className={`rmt-pane ${dropTarget === "remote" ? "drop" : ""}`} data-pane="remote">
          <div className="rmt-bar">
            <span className="rmt-pane-title">🌐 {t.remotePane}</span>
            <button
              className="rmt-btn"
              disabled={busy || cwd === "/"}
              onClick={() => listDir(parentPath(cwd))}
              title={t.up}
            >
              ⬆
            </button>
            <button className="rmt-btn" disabled={busy} onClick={() => listDir(cwd)} title={t.refresh}>
              ↻
            </button>
            <span className="rmt-path" title={cwd}>
              {cwd}
            </span>
            <span className="rmt-spacer" />
            <button className="rmt-btn" disabled={busy} onClick={upload} title={t.upload}>
              ⬆ {t.upload}
            </button>
            <button className="rmt-btn" disabled={busy} onClick={mkdir} title={t.newFolder}>
              📁＋
            </button>
            <button className="rmt-btn danger" disabled={busy} onClick={disconnect}>
              {t.disconnect}
            </button>
          </div>
          <div className="rmt-list">
            {listHead}
            {files.map((f) => fileRow(f, "remote"))}
            {files.length === 0 && !busy && <div className="rmt-empty">{t.empty}</div>}
          </div>
        </div>
      </div>

      <div className="rmt-drag-hint">{t.dragHint}</div>

      {dragGhost && (
        <div className="rmt-drag-ghost" style={{ left: dragGhost.x + 14, top: dragGhost.y + 14 }}>
          {dragGhost.label}
        </div>
      )}

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
