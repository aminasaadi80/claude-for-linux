import { useCallback, useEffect, useRef, useState } from "react";

// A small promise-based text prompt that renders its own modal, so we don't rely
// on window.prompt() (unreliable / unstyled under WebKitGTK on Linux).
export function usePrompt() {
  const [state, setState] = useState<{ message: string; value: string } | null>(null);
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const ask = useCallback((message: string, initial = ""): Promise<string | null> => {
    setState({ message, value: initial });
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = (v: string | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setState(null);
  };

  const node = state ? (
    <div className="prompt-overlay" onClick={() => finish(null)}>
      <div className="prompt-box" onClick={(e) => e.stopPropagation()}>
        <div className="prompt-msg">{state.message}</div>
        <input
          className="prompt-input"
          autoFocus
          value={state.value}
          onChange={(e) => setState({ ...state, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(state.value);
            if (e.key === "Escape") finish(null);
          }}
        />
        <div className="prompt-actions">
          <button className="prompt-btn" onClick={() => finish(null)}>
            ✕
          </button>
          <button className="prompt-btn primary" onClick={() => finish(state.value)}>
            ✓
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { ask, node };
}

// A promise-based yes/no confirmation that renders its own themed modal, so we
// don't rely on window.confirm() (which is ignored / doesn't block under
// WebKitGTK on Linux — the same reason usePrompt exists).
export function useConfirm() {
  const [state, setState] = useState<{
    message: string;
    ok: string;
    cancel: string;
    danger: boolean;
  } | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback(
    (message: string, opts?: { ok?: string; cancel?: string; danger?: boolean }): Promise<boolean> => {
      setState({
        message,
        ok: opts?.ok ?? "✓",
        cancel: opts?.cancel ?? "✕",
        danger: opts?.danger ?? false,
      });
      return new Promise((resolve) => {
        resolver.current = resolve;
      });
    },
    []
  );

  const finish = useCallback((v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setState(null);
  }, []);

  // Enter confirms, Escape cancels — even without a focused input.
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state, finish]);

  const node = state ? (
    <div className="prompt-overlay" onClick={() => finish(false)}>
      <div className="prompt-box" onClick={(e) => e.stopPropagation()}>
        <div className="prompt-msg">{state.message}</div>
        <div className="prompt-actions">
          <button className="prompt-btn" onClick={() => finish(false)}>
            {state.cancel}
          </button>
          <button
            className={`prompt-btn ${state.danger ? "danger" : "primary"}`}
            autoFocus
            onClick={() => finish(true)}
          >
            {state.ok}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, node };
}
