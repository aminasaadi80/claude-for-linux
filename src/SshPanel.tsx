import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import TerminalView, { type SshConfig } from "./Terminal";
import { useConfirm } from "./usePrompt";

type Lang = "en" | "fa";

export type { SshConfig };

const S = {
  en: {
    name: "Name",
    namePh: "My server",
    host: "Host",
    port: "Port",
    user: "Username",
    password: "Password",
    passwordPh: "(optional — asked in terminal if empty)",
    key: "Private key",
    keyPick: "Choose key file…",
    proxy: "Proxy (optional)",
    proxyPh: "socks5://127.0.0.1:1080 or 127.0.0.1:8080",
    proxyHint:
      "Separate from the app proxy. Routed through SSH ProxyCommand — needs `nc` (netcat-openbsd) installed. Prefix with socks5:// or http:// (default http).",
    connect: "Connect",
    disconnect: "Disconnect",
    reconnect: "Reconnect",
    dropped: "Connection lost",
    save: "Save this server",
    saved: "Saved servers",
    fillHost: "Enter a host to connect.",
    connectedTo: "Connected to",
    del: "Delete",
    cancel: "Cancel",
    delConfirm: (n: string) => `Delete saved server "${n}"?`,
  },
  fa: {
    name: "نام",
    namePh: "سرور من",
    host: "هاست",
    port: "پورت",
    user: "نام کاربری",
    password: "رمز عبور",
    passwordPh: "(اختیاری — اگر خالی باشد در ترمینال پرسیده می‌شود)",
    key: "کلید خصوصی",
    keyPick: "انتخاب فایل کلید…",
    proxy: "پروکسی (اختیاری)",
    proxyPh: "socks5://127.0.0.1:1080 یا 127.0.0.1:8080",
    proxyHint:
      "جدا از پروکسی برنامه است. از طریق ProxyCommand در SSH رد می‌شود — به `nc` (netcat-openbsd) نیاز دارد. با socks5:// یا http:// شروع کن (پیش‌فرض http).",
    connect: "اتصال",
    disconnect: "قطع",
    reconnect: "اتصال مجدد",
    dropped: "اتصال قطع شد",
    save: "ذخیره‌ی این سرور",
    saved: "سرورهای ذخیره‌شده",
    fillHost: "برای اتصال یک هاست وارد کن.",
    connectedTo: "متصل به",
    del: "حذف",
    cancel: "انصراف",
    delConfirm: (n: string) => `سرور ذخیره‌شده‌ی «${n}» حذف شود؟`,
  },
};

function label(c: SshConfig): string {
  return (
    c.name?.trim() ||
    `${c.username ? `${c.username}@` : ""}${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ""}`
  );
}

export default function SshPanel({
  connId,
  config,
  saved,
  lang,
  fontSize,
  onConfigChange,
  onSaveConnection,
  onDeleteConnection,
  onUseSaved,
}: {
  connId: string;
  config: SshConfig;
  saved: SshConfig[];
  lang: Lang;
  fontSize?: number;
  onConfigChange: (c: SshConfig) => void;
  onSaveConnection: (c: SshConfig) => void;
  onDeleteConnection: (c: SshConfig) => void;
  onUseSaved: (c: SshConfig) => void;
}) {
  const t = S[lang];
  const { confirm, node: confirmNode } = useConfirm();
  const [connected, setConnected] = useState(false);
  // true once the ssh session drops while still on the live view
  const [exited, setExited] = useState(false);
  // bumped on every connect so the terminal remounts (fresh ssh session)
  const [nonce, setNonce] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const set = (patch: Partial<SshConfig>) => onConfigChange({ ...config, ...patch });

  // make sure the ssh process is killed if the tab/component goes away
  useEffect(() => {
    return () => {
      invoke("pty_close", { termId: connId }).catch(() => {});
    };
  }, [connId]);

  const connect = () => {
    if (!config.host.trim()) {
      setErr(t.fillHost);
      return;
    }
    setErr(null);
    setExited(false);
    setNonce((n) => n + 1);
    setConnected(true);
  };

  // relaunch ssh in the same tab: close any stale process, remount the terminal
  const reconnect = () => {
    invoke("pty_close", { termId: connId }).catch(() => {});
    setExited(false);
    setNonce((n) => n + 1);
  };

  const disconnect = () => {
    invoke("pty_close", { termId: connId }).catch(() => {});
    setExited(false);
    setConnected(false);
  };

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
                    <button className="rmt-chip" onClick={() => onUseSaved(s)}>
                      🔐 {label(s)}
                    </button>
                    <button
                      className="rmt-chip-del"
                      title={t.del}
                      onClick={async () => {
                        if (await confirm(t.delConfirm(label(s)), { ok: t.del, cancel: t.cancel, danger: true }))
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
            <input value={config.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder={t.namePh} />
          </div>
          <div className="rmt-row">
            <label>{t.host}</label>
            <input value={config.host} onChange={(e) => set({ host: e.target.value })} placeholder="example.com" />
            <label className="rmt-port-l">{t.port}</label>
            <input
              className="rmt-port"
              type="number"
              value={config.port}
              onChange={(e) => set({ port: Number(e.target.value) || 22 })}
            />
          </div>
          <div className="rmt-row">
            <label>{t.user}</label>
            <input value={config.username} onChange={(e) => set({ username: e.target.value })} placeholder="root" />
          </div>
          <div className="rmt-row">
            <label>{t.password}</label>
            <input
              type="password"
              value={config.password ?? ""}
              onChange={(e) => set({ password: e.target.value })}
              placeholder={t.passwordPh}
            />
          </div>
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
            <label>{t.proxy}</label>
            <input value={config.proxy ?? ""} onChange={(e) => set({ proxy: e.target.value })} placeholder={t.proxyPh} />
          </div>
          <p className="hint" style={{ margin: "2px 0 0" }}>
            {t.proxyHint}
          </p>

          <div className="rmt-actions">
            <button className="rmt-btn primary" onClick={connect}>
              🔌 {t.connect}
            </button>
            <button className="rmt-btn" onClick={() => onSaveConnection(config)}>
              💾 {t.save}
            </button>
          </div>
          {err && (
            <div className="rmt-toast" onClick={() => setErr(null)}>
              {err}
            </div>
          )}
        </div>
        {confirmNode}
      </div>
    );
  }

  return (
    <div className="rmt-panel ssh-live">
      <div className="rmt-bar">
        <span className="rmt-path" title={label(config)}>
          {exited ? "⚠️" : "🔐"} {exited ? t.dropped : t.connectedTo} {label(config)}
        </span>
        <span className="rmt-spacer" />
        {exited && (
          <button className="rmt-btn primary" onClick={reconnect}>
            🔄 {t.reconnect}
          </button>
        )}
        <button className="rmt-btn danger" onClick={disconnect}>
          {t.disconnect}
        </button>
      </div>
      <TerminalView
        key={nonce}
        termId={connId}
        cwd=""
        ssh={config}
        fontSize={fontSize}
        flush
        onExit={() => setExited(true)}
      />
    </div>
  );
}
