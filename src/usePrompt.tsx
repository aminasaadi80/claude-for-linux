import { useCallback, useRef, useState } from "react";

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
