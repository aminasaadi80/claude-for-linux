import type { ReactNode } from "react";

// The "project folder" bar above terminal and Git tabs: a read-only path field
// with a picker button, an optional clear button, and any extra tab-specific
// controls passed as children (auto-approve toggle, git proxy field, …).
export default function CwdBar({
  cwd,
  label,
  placeholder,
  chooseTitle,
  clearTitle,
  onPick,
  onClear,
  children,
}: {
  cwd: string;
  label: string;
  placeholder: string;
  chooseTitle: string;
  clearTitle: string;
  onPick: () => void;
  onClear: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="cwd-bar">
      <label>{label}</label>
      <input
        type="text"
        placeholder={placeholder}
        value={cwd || ""}
        readOnly
        onClick={onPick}
        style={{ cursor: "pointer" }}
      />
      <button className="browse-btn" onClick={onPick} title={chooseTitle}>
        📁
      </button>
      {cwd && (
        <button className="browse-btn" onClick={onClear} title={clearTitle}>
          ✕
        </button>
      )}
      {children}
    </div>
  );
}
