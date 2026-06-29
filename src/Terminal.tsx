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

// A real interactive `claude` running in a PTY, rendered with xterm.js.
export default function TerminalView({
  termId,
  cwd,
  extraArgs,
  fontSize,
}: {
  termId: string;
  cwd: string;
  extraArgs?: string[];
  fontSize?: number;
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

    // clipboard (calls run inside user-gesture handlers, which webkit2gtk requires)
    const copySel = () => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    };
    const pasteClipboard = () =>
      navigator.clipboard
        .readText()
        .then((txt) => {
          if (txt) invoke("pty_write", { termId, data: txt }).catch(() => {});
        })
        .catch(() => {});

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        copySel();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
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
    invoke("pty_open", {
      termId,
      cwd: cwd || null,
      rows: term.rows,
      cols: term.cols,
      extraArgs: extraArgs ?? [],
    }).catch(() => {});

    const unData = listen("pty://data", (e: { payload: { id: string; data: string } }) => {
      if (e.payload.id === termId && !disposed) term.write(b64ToBytes(e.payload.data));
    });
    const unExit = listen("pty://exit", (e: { payload: { id: string } }) => {
      if (e.payload.id === termId && !disposed) term.write("\r\n\x1b[33m[claude exited — close this tab]\x1b[0m\r\n");
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

  return <div className="xterm-host" ref={hostRef} />;
}
