import { useRef, useState } from "react";
import type { Tab } from "../types";
import { APP_STR, type Lang } from "../i18n";

const TAB_ICON: Record<Tab["kind"], string> = {
  terminal: "🖥",
  git: "⎇",
  remote: "🌐",
  ssh: "🔐",
  chat: "💬",
};

// The tab bar: selectable/closable/renamable tabs with pointer-driven
// drag-reordering (HTML5 DnD is swallowed by Tauri's native file drag-drop
// handler on webkit, so we drive it ourselves with pointers), plus the
// new-tab buttons.
export default function TabStrip({
  tabs,
  activeId,
  lang,
  onSelect,
  onClose,
  onRename,
  onReorder,
  onAddChat,
  onAddTerminal,
  onAddGit,
  onAddRemote,
  onAddSsh,
}: {
  tabs: Tab[];
  activeId: string;
  lang: Lang;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onReorder: (fromId: string, overId: string) => void;
  onAddChat: () => void;
  onAddTerminal: (extra?: string[]) => void;
  onAddGit: () => void;
  onAddRemote: () => void;
  onAddSsh: () => void;
}) {
  const t = APP_STR[lang];
  const dragState = useRef<{ id: string; startX: number; moved: boolean } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const onTabPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || editingId === id) return;
    dragState.current = { id, startX: e.clientX, moved: false };
  };
  const onTabPointerMove = (e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st) return;
    if (!st.moved) {
      if (Math.abs(e.clientX - st.startX) < 5) return; // small threshold = still a click
      st.moved = true;
      setDragId(st.id);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const over = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest(
      "[data-tab-id]"
    );
    const overId = over?.getAttribute("data-tab-id");
    if (overId && overId !== st.id) onReorder(st.id, overId);
  };
  const onTabPointerUp = () => {
    dragState.current = null;
    setDragId(null);
  };
  const commitRename = () => {
    if (editingId) onRename(editingId, editDraft.trim());
    setEditingId(null);
  };

  return (
    <div className="tab-strip">
      {tabs.map((tb) => (
        <div
          key={tb.id}
          data-tab-id={tb.id}
          className={`tab tab-${tb.kind} ${tb.id === activeId ? "active" : ""} ${dragId === tb.id ? "dragging" : ""}`}
          onPointerDown={(e) => onTabPointerDown(e, tb.id)}
          onPointerMove={onTabPointerMove}
          onPointerUp={onTabPointerUp}
          onClick={() => onSelect(tb.id)}
          onDoubleClick={() => {
            setEditingId(tb.id);
            setEditDraft(tb.title);
          }}
          title={tb.title}
        >
          <span className="tab-ico">{TAB_ICON[tb.kind]}</span>
          {editingId === tb.id ? (
            <input
              className="tab-edit"
              autoFocus
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <span className="tab-title">{tb.title}</span>
          )}
          {tabs.length > 1 && (
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tb.id);
              }}
            >
              ✕
            </span>
          )}
        </div>
      ))}
      <button className="tab-add" onClick={() => onAddTerminal()} title={t.newTerm}>
        🖥
      </button>
      <button className="tab-add" onClick={() => onAddTerminal(["--resume"])} title={t.resume}>
        ↺
      </button>
      <button className="tab-add" onClick={onAddChat} title={t.newTab}>
        💬
      </button>
      <button className="tab-add" onClick={onAddGit} title={t.newGit}>
        ⎇
      </button>
      <button className="tab-add" onClick={onAddRemote} title={t.newRemote}>
        🌐
      </button>
      <button className="tab-add" onClick={onAddSsh} title={t.newSsh}>
        🔐
      </button>
    </div>
  );
}
