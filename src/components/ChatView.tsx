import type { RefObject } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import TerminalView from "../Terminal";
import { APP_STR, type Lang } from "../i18n";
import type { Perm, Tab } from "../types";

const PERMS: { id: Perm; en: string; fa: string }[] = [
  { id: "default", en: "Safe (ask)", fa: "امن (پرسش)" },
  { id: "acceptEdits", en: "Accept edits", fa: "تأیید ویرایش‌ها" },
  { id: "bypassPermissions", en: "Full access", fa: "دسترسی کامل" },
];

// The chat tab body: folder bar, streamed messages, composer, and the optional
// side-by-side terminal split.
export default function ChatView({
  tab,
  lang,
  fontSize,
  input,
  imgPreview,
  busy,
  scrollRef,
  onInputChange,
  onSend,
  onStop,
  onPickFolder,
  onOpenTerminal,
  onPatchTab,
  onCopyMsg,
  onClearImgPreview,
}: {
  tab: Tab;
  lang: Lang;
  fontSize: number;
  input: string;
  imgPreview: string | null;
  busy: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onPickFolder: () => void;
  onOpenTerminal: () => void;
  onPatchTab: (patch: Partial<Tab>) => void;
  onCopyMsg: (content: string) => void;
  onClearImgPreview: () => void;
}) {
  const t = APP_STR[lang];
  const messages = tab.messages;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <>
      <div className="cwd-bar">
        <label>{t.folder}</label>
        <input
          type="text"
          placeholder={t.folderPick}
          value={tab.cwd ?? ""}
          readOnly
          onClick={onPickFolder}
          style={{ cursor: "pointer" }}
        />
        <button className="browse-btn" onClick={onPickFolder} title={t.choose}>
          📁
        </button>
        <button className="browse-btn" onClick={onOpenTerminal} title={t.terminal}>
          🖥
        </button>
        <button
          className={`browse-btn ${tab.split ? "on" : ""}`}
          onClick={() => onPatchTab({ split: !tab.split })}
          title={t.split}
        >
          ⊟
        </button>
        {tab.cwd && (
          <button className="browse-btn" onClick={() => onPatchTab({ cwd: "" })} title={t.clearField}>
            ✕
          </button>
        )}
        <select
          className="perm-select"
          value={tab.permission ?? "default"}
          onChange={(e) => onPatchTab({ permission: e.target.value as Perm })}
          title={t.perm}
        >
          {PERMS.map((p) => (
            <option key={p.id} value={p.id}>
              {lang === "fa" ? p.fa : p.en}
            </option>
          ))}
        </select>
      </div>

      <div className={`chat-body ${tab.split ? "split" : ""}`}>
        <div className="chat-col">
          <div className="messages" ref={scrollRef}>
            {messages.length === 0 && <div className="empty">{t.empty}</div>}
            {messages.map((m, i) =>
              m.kind === "tool" ? (
                <div key={i} className="tool-line">
                  <span className="tool-ico">🔧</span>
                  {m.content}
                </div>
              ) : (
                <div key={i} className={`msg ${m.role} ${m.error ? "err" : ""}`}>
                  <div className="avatar">{m.role === "user" ? "🧑" : "✳"}</div>
                  <div className="bubble">
                    {m.role === "assistant" && m.content ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {m.content}
                      </ReactMarkdown>
                    ) : (
                      m.content
                    )}
                    {m.streaming && <span className="cursor">▍</span>}
                  </div>
                  {m.content && !m.streaming && (
                    <button className="copy-btn" onClick={() => onCopyMsg(m.content)} title={t.copy}>
                      ⧉
                    </button>
                  )}
                </div>
              )
            )}
          </div>

          {imgPreview && (
            <div className="img-preview">
              <img src={convertFileSrc(imgPreview)} alt="" />
              <span className="rm" onClick={onClearImgPreview}>
                ✕
              </span>
            </div>
          )}

          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t.ph}
              rows={1}
            />
            {busy ? (
              <button className="stop-btn" onClick={onStop}>
                ⏹ {t.stop}
              </button>
            ) : (
              <button onClick={onSend} disabled={!input.trim()}>
                {t.send}
              </button>
            )}
          </div>
        </div>

        {tab.split && (
          <div className="split-term">
            <TerminalView termId={`${tab.id}:split`} cwd={tab.cwd} fontSize={fontSize} />
          </div>
        )}
      </div>
    </>
  );
}
