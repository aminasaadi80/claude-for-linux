import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import TerminalView, { type SshConfig } from "./Terminal";
import { useConfirm } from "./usePrompt";
import { SSH_STR, type Lang } from "./i18n";
import SavedChips from "./components/SavedChips";

export type { SshConfig };

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
  fontFamily,
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
  /** monospace stack for the ssh terminal */
  fontFamily?: string;
  onConfigChange: (c: SshConfig) => void;
  onSaveConnection: (c: SshConfig) => void;
  onDeleteConnection: (c: SshConfig) => void;
  onUseSaved: (c: SshConfig) => void;
}) {
  const t = SSH_STR[lang];
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
          <SavedChips
            label={t.saved}
            icon="🔐"
            items={saved}
            chipLabel={label}
            deleteTitle={t.del}
            onUse={onUseSaved}
            onDelete={async (s) => {
              if (await confirm(t.delConfirm(label(s)), { ok: t.del, cancel: t.cancel, danger: true }))
                onDeleteConnection(s);
            }}
          />

          <div className="rmt-row">
            <label>{t.name}</label>
            <input
              value={config.name ?? ""}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={t.namePh}
            />
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
              onChange={(e) => set({ port: Number(e.target.value) || 22 })}
            />
          </div>
          <div className="rmt-row">
            <label>{t.user}</label>
            <input
              value={config.username}
              onChange={(e) => set({ username: e.target.value })}
              placeholder="root"
            />
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
        fontFamily={fontFamily}
        flush
        onExit={() => setExited(true)}
      />
    </div>
  );
}
