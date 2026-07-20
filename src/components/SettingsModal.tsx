import { openUrl } from "@tauri-apps/plugin-opener";
import { APP_STR, type Lang } from "../i18n";
import { TERM_FONTS } from "../Terminal";

const SITE_URL = "https://aminasaadi80.github.io/claude-for-linux/";

type Theme = "dark" | "light";

// The ⚙ settings dialog: language, theme, font size, app proxy and the about box.
export default function SettingsModal({
  lang,
  theme,
  fontSize,
  termFontId,
  termEnglish,
  termFlat,
  proxyDraft,
  savedProxy,
  appVersion,
  onClose,
  onSetLang,
  onSetTheme,
  onSetFontSize,
  onSetTermFont,
  onSetTermEnglish,
  onSetTermFlat,
  onProxyDraftChange,
  onSaveProxy,
}: {
  lang: Lang;
  theme: Theme;
  fontSize: number;
  termFontId: string;
  termEnglish: boolean;
  termFlat: boolean;
  proxyDraft: string;
  /** the proxy value currently persisted in settings (for the Save/Saved state) */
  savedProxy: string;
  appVersion: string;
  onClose: () => void;
  onSetLang: (l: Lang) => void;
  onSetTheme: (th: Theme) => void;
  onSetFontSize: (px: number) => void;
  onSetTermFont: (id: string) => void;
  onSetTermEnglish: (v: boolean) => void;
  onSetTermFlat: (v: boolean) => void;
  onProxyDraftChange: (v: string) => void;
  onSaveProxy: () => void;
}) {
  const t = APP_STR[lang];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t.settings}</h2>

        <label>{t.language}</label>
        <div className="lang-switch">
          <button className={lang === "en" ? "active" : ""} onClick={() => onSetLang("en")}>
            English
          </button>
          <button className={lang === "fa" ? "active" : ""} onClick={() => onSetLang("fa")}>
            فارسی
          </button>
        </div>

        <label style={{ marginTop: 14 }}>{t.theme}</label>
        <div className="lang-switch">
          <button className={theme === "dark" ? "active" : ""} onClick={() => onSetTheme("dark")}>
            {t.dark}
          </button>
          <button className={theme === "light" ? "active" : ""} onClick={() => onSetTheme("light")}>
            {t.light}
          </button>
        </div>

        <label style={{ marginTop: 14 }}>
          {t.fontSize}: {fontSize}px
        </label>
        <input
          type="range"
          min={11}
          max={20}
          value={fontSize}
          onChange={(e) => onSetFontSize(Number(e.target.value))}
          style={{ width: "100%" }}
        />

        <label style={{ marginTop: 14 }}>{t.termFont}</label>
        <select
          className="perm-select"
          style={{ width: "100%" }}
          value={termFontId}
          onChange={(e) => onSetTermFont(e.target.value)}
        >
          {TERM_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <p className="hint">{t.termFontHint}</p>

        <label style={{ marginTop: 14 }}>{t.termFlat}</label>
        <div className="lang-switch">
          <button className={termFlat ? "active" : ""} onClick={() => onSetTermFlat(true)}>
            {t.on}
          </button>
          <button className={!termFlat ? "active" : ""} onClick={() => onSetTermFlat(false)}>
            {t.off}
          </button>
        </div>
        <p className="hint">{t.termFlatHint}</p>

        <label style={{ marginTop: 14 }}>{t.termEnglish}</label>
        <div className="lang-switch">
          <button className={termEnglish ? "active" : ""} onClick={() => onSetTermEnglish(true)}>
            {t.on}
          </button>
          <button className={!termEnglish ? "active" : ""} onClick={() => onSetTermEnglish(false)}>
            {t.off}
          </button>
        </div>
        <p className="hint">{t.termEnglishHint}</p>

        <label style={{ marginTop: 14 }}>{t.proxy}</label>
        <div className="proxy-row">
          <input
            type="text"
            value={proxyDraft}
            onChange={(e) => onProxyDraftChange(e.target.value)}
            onBlur={onSaveProxy}
            placeholder="127.0.0.1:8080"
          />
          <button onClick={onSaveProxy} disabled={proxyDraft.trim() === savedProxy}>
            {proxyDraft.trim() === savedProxy ? t.proxySaved : t.proxySave}
          </button>
        </div>
        <p className="hint">{t.proxyHint}</p>

        <p className="hint" style={{ marginTop: 14 }}>
          {t.cliHint}
        </p>
        <div className="about">
          <span className="about-label">{t.about}</span>
          <div className="about-row">
            <span>
              {t.version} <b>{appVersion || "—"}</b>
            </span>
          </div>
          <div className="about-row">
            <span>
              {t.madeBy} <b>{t.creator}</b>
            </span>
            <a className="about-link" onClick={() => openUrl("https://aminasaadi.ir")}>
              aminasaadi.ir
            </a>
          </div>
          <div className="about-row">
            <span>{t.website}</span>
            <a className="about-link" onClick={() => openUrl(SITE_URL)}>
              aminasaadi80.github.io/claude-for-linux
            </a>
          </div>
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
