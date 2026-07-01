import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export interface SshConfig {
  name?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  key_path?: string;
  /** optional per-connection proxy, independent of the app proxy */
  proxy?: string;
}

// A real interactive PTY rendered with xterm.js. By default it runs `claude`;
// when `ssh` is given it runs an interactive `ssh` login instead.
export default function TerminalView({
  termId,
  cwd,
  extraArgs,
  fontSize,
  ssh,
  flush,
}: {
  termId: string;
  cwd: string;
  extraArgs?: string[];
  fontSize?: number;
  /** when set, open an SSH session instead of the claude PTY */
  ssh?: SshConfig;
  /** trim the extra bottom padding (used for plain shells / ssh) */
  flush?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", monospace',
      fontSize: fontSize ?? 13,
      cursorBlink: true,
      theme: {
        background: "#1a1714",
        foreground: "#ece6df",
        cursor: "#d97757",
        selectionBackground: "#3a342e",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    fit.fit();

    // clipboard via the Rust command (system tool — reliable on Wayland/webkit2gtk)
    const copySel = () => {
      const sel = term.getSelection();
      if (sel) invoke("clipboard_set", { text: sel }).catch(() => {});
    };
    const pasteClipboard = () =>
      invoke<string>("clipboard_get")
        .then((txt) => {
          if (txt) invoke("pty_write", { termId, data: txt }).catch(() => {});
        })
        .catch(() => {});

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        copySel();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
        // preventDefault stops webkit's own native paste from also firing —
        // webkit2gtk crashes when it tries to paste image clipboard content,
        // so we route paste exclusively through our text-only clipboard_get.
        e.preventDefault();
        pasteClipboard();
        return false;
      }
      return true;
    });

    const host = hostRef.current;
    // copy-on-select: release the mouse with a selection → it's copied automatically
    const onMouseUp = () => {
      if (term.hasSelection()) copySel();
    };
    const onContext = (ev: MouseEvent) => {
      ev.preventDefault();
      if (term.hasSelection()) {
        copySel();
        term.clearSelection();
      } else {
        pasteClipboard();
      }
    };
    const onAux = (ev: MouseEvent) => {
      if (ev.button === 1) {
        ev.preventDefault();
        pasteClipboard(); // middle-click paste
      }
    };
    host?.addEventListener("mouseup", onMouseUp);
    host?.addEventListener("contextmenu", onContext);
    host?.addEventListener("auxclick", onAux);

    let disposed = false;
    if (ssh) {
      invoke("ssh_open", {
        termId,
        creds: ssh,
        rows: term.rows,
        cols: term.cols,
      }).catch((e) => term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`));
    } else {
      invoke("pty_open", {
        termId,
        cwd: cwd || null,
        rows: term.rows,
        cols: term.cols,
        extraArgs: extraArgs ?? [],
      }).catch(() => {});
    }

    const unData = listen("pty://data", (e: { payload: { id: string; data: string } }) => {
      if (e.payload.id === termId && !disposed) term.write(b64ToBytes(e.payload.data));
    });
    const unExit = listen("pty://exit", (e: { payload: { id: string } }) => {
      if (e.payload.id === termId && !disposed)
        term.write(
          ssh
            ? "\r\n\x1b[33m[ssh session ended — press Disconnect or reconnect]\x1b[0m\r\n"
            : "\r\n\x1b[33m[claude exited — close this tab]\x1b[0m\r\n"
        );
    });
    const dataSub = term.onData((d) => invoke("pty_write", { termId, data: d }).catch(() => {}));

    const doFit = () => {
      try {
        fit.fit();
        invoke("pty_resize", { termId, rows: term.rows, cols: term.cols }).catch(() => {});
      } catch {
        /* ignore */
      }
    };
    const ro = new ResizeObserver(doFit);
    if (hostRef.current) ro.observe(hostRef.current);
    window.addEventListener("resize", doFit);
    setTimeout(() => term.focus(), 50);

    return () => {
      disposed = true;
      window.removeEventListener("resize", doFit);
      host?.removeEventListener("mouseup", onMouseUp);
      host?.removeEventListener("contextmenu", onContext);
      host?.removeEventListener("auxclick", onAux);
      ro.disconnect();
      dataSub.dispose();
      unData.then((f) => f());
      unExit.then((f) => f());
      invoke("pty_close", { termId }).catch(() => {});
      term.dispose();
    };
  }, [termId]);

  return <div className={`xterm-host${flush ? " flush" : ""}`} ref={hostRef} />;
}
