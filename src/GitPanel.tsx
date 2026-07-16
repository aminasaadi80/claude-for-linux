import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePrompt, useConfirm } from "./usePrompt";
import { useToast } from "./useToast";
import { GIT_STR, type Lang } from "./i18n";

interface GitFile {
  path: string;
  staged: string;
  unstaged: string;
  staged_flag: boolean;
  unstaged_flag: boolean;
  untracked: boolean;
}
interface GitStatus {
  is_repo: boolean;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}
interface GitBranches {
  current: string;
  branches: string[];
}
interface GitCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  message: string;
}

function statusLabel(f: GitFile): string {
  if (f.untracked) return "?";
  const c = (f.staged_flag ? f.staged : f.unstaged).trim();
  return c || "•";
}

export default function GitPanel({ cwd, lang, proxy }: { cwd: string; lang: Lang; proxy?: string }) {
  const t = GIT_STR[lang];
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast, flash, clear: clearToast } = useToast();
  const { ask, node: promptNode } = usePrompt();
  const { confirm, node: confirmNode } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const st = await invoke<GitStatus>("git_status", { cwd });
      setStatus(st);
      if (st.is_repo) {
        setBranches(await invoke<GitBranches>("git_branches", { cwd }));
        setLog(await invoke<GitCommit[]>("git_log", { cwd, limit: 50 }));
      } else {
        setBranches(null);
        setLog([]);
      }
    } catch (e) {
      flash(String(e));
    }
  }, [cwd, flash]);

  useEffect(() => {
    setSel(null);
    setDiff("");
    refresh();
  }, [refresh]);

  // load diff when a file is selected
  useEffect(() => {
    if (!sel) {
      setDiff("");
      return;
    }
    invoke<string>("git_diff", { cwd, path: sel.path, staged: sel.staged })
      .then(setDiff)
      .catch((e) => setDiff(String(e)));
  }, [sel, cwd, status]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string) => {
      setBusy(true);
      try {
        const r = await fn();
        if (okMsg) flash(okMsg);
        else if (typeof r === "string" && r.trim()) flash(r.trim());
        await refresh();
      } catch (e) {
        flash(String(e));
      } finally {
        setBusy(false);
      }
    },
    [flash, refresh]
  );

  if (!cwd.trim()) {
    return <div className="git-empty">{t.pickFolder}</div>;
  }
  if (status && !status.is_repo) {
    return (
      <div className="git-empty">
        {t.noRepo}
        <button className="git-btn" style={{ marginTop: 12 }} onClick={refresh}>
          ↻ {t.refresh}
        </button>
      </div>
    );
  }

  const staged = status?.files.filter((f) => f.staged_flag) ?? [];
  const unstaged = status?.files.filter((f) => !f.staged_flag) ?? [];

  const fileRow = (f: GitFile, isStaged: boolean) => (
    <div
      key={(isStaged ? "s:" : "u:") + f.path}
      className={`git-file ${sel?.path === f.path && sel?.staged === isStaged ? "active" : ""}`}
      onClick={() => setSel({ path: f.path, staged: isStaged })}
      title={f.path}
    >
      <span className={`git-stat git-stat-${statusLabel(f)}`}>{statusLabel(f)}</span>
      <span className="git-path">{f.path}</span>
      <span className="git-file-actions">
        {isStaged ? (
          <button
            className="git-mini"
            title={t.unstage}
            onClick={(e) => {
              e.stopPropagation();
              run(() => invoke("git_unstage", { cwd, path: f.path }));
            }}
          >
            −
          </button>
        ) : (
          <>
            <button
              className="git-mini"
              title={t.discard}
              onClick={async (e) => {
                e.stopPropagation();
                if (
                  await confirm(t.discardConfirm(f.path), { ok: t.discard, cancel: t.cancel, danger: true })
                )
                  run(() => invoke("git_discard", { cwd, path: f.path, untracked: f.untracked }));
              }}
            >
              ↶
            </button>
            <button
              className="git-mini"
              title={t.stage}
              onClick={(e) => {
                e.stopPropagation();
                run(() => invoke("git_stage", { cwd, path: f.path }));
              }}
            >
              ＋
            </button>
          </>
        )}
      </span>
    </div>
  );

  return (
    <div className="git-panel">
      {/* branch / remote bar */}
      <div className="git-bar">
        <select
          className="git-branch"
          value={branches?.current ?? ""}
          disabled={busy}
          onChange={(e) => {
            const b = e.target.value;
            if (b && b !== branches?.current)
              run(() => invoke("git_checkout", { cwd, branch: b, create: false }));
          }}
        >
          {!branches?.branches.includes(branches?.current ?? "") && branches?.current && (
            <option value={branches.current}>{branches.current}</option>
          )}
          {branches?.branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <button
          className="git-btn"
          disabled={busy}
          title={t.newBranch}
          onClick={async () => {
            const name = await ask(t.newBranchPrompt);
            if (name && name.trim())
              run(() => invoke("git_checkout", { cwd, branch: name.trim(), create: true }));
          }}
        >
          ⎇＋
        </button>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-track">
            {status.ahead > 0 && <span title={t.ahead}>↑{status.ahead}</span>}
            {status.behind > 0 && <span title={t.behind}>↓{status.behind}</span>}
          </span>
        )}
        <span className="git-spacer" />
        <button
          className="git-btn"
          disabled={busy}
          onClick={() => run(() => invoke("git_fetch", { cwd, proxy }))}
        >
          ⟳ {t.fetch}
        </button>
        <button
          className="git-btn"
          disabled={busy}
          onClick={() => run(() => invoke("git_pull", { cwd, proxy }))}
        >
          ↓ {t.pull}
        </button>
        <button
          className="git-btn"
          disabled={busy}
          onClick={() => run(() => invoke("git_push", { cwd, proxy }), t.done)}
        >
          ↑ {t.push}
        </button>
        <button className="git-btn" disabled={busy} onClick={refresh} title={t.refresh}>
          ↻
        </button>
      </div>

      <div className="git-body">
        {/* left: changes + commit */}
        <div className="git-left">
          <div className="git-section-head">
            <span>
              {t.staged} ({staged.length})
            </span>
            {staged.length > 0 && (
              <button
                className="git-link"
                disabled={busy}
                onClick={() => run(() => invoke("git_unstage_all", { cwd }))}
              >
                {t.unstageAll}
              </button>
            )}
          </div>
          <div className="git-list">{staged.map((f) => fileRow(f, true))}</div>

          <div className="git-section-head">
            <span>
              {t.unstaged} ({unstaged.length})
            </span>
            {unstaged.length > 0 && (
              <button
                className="git-link"
                disabled={busy}
                onClick={() => run(() => invoke("git_stage_all", { cwd }))}
              >
                {t.stageAll}
              </button>
            )}
          </div>
          <div className="git-list">{unstaged.map((f) => fileRow(f, false))}</div>

          {status && status.files.length === 0 && <div className="git-clean">{t.nothing}</div>}

          <div className="git-commit">
            <textarea
              placeholder={t.commitMsg}
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              rows={3}
            />
            <div className="git-commit-actions">
              <button
                className="git-btn primary"
                disabled={busy || !commitMsg.trim() || staged.length === 0}
                onClick={() =>
                  run(async () => {
                    await invoke("git_commit", { cwd, message: commitMsg });
                    setCommitMsg("");
                  }, t.done)
                }
              >
                {t.commit}
              </button>
              <button
                className="git-btn"
                disabled={busy || !commitMsg.trim() || staged.length === 0}
                onClick={() =>
                  run(async () => {
                    await invoke("git_commit", { cwd, message: commitMsg });
                    setCommitMsg("");
                    await invoke("git_push", { cwd, proxy });
                  }, t.done)
                }
              >
                {t.commitPush}
              </button>
            </div>
          </div>
        </div>

        {/* right: diff or history */}
        <div className="git-right">
          {sel ? (
            <>
              <div className="git-section-head git-diff-head">
                <span className="git-diff-file" title={sel.path}>
                  {sel.path}
                </span>
                <button className="git-link" onClick={() => setSel(null)} title={t.closeDiff}>
                  ✕ {t.closeDiff}
                </button>
              </div>
              <pre className="git-diff">
                {diff.split("\n").map((ln, i) => {
                  let cls = "";
                  if (ln.startsWith("+") && !ln.startsWith("+++")) cls = "add";
                  else if (ln.startsWith("-") && !ln.startsWith("---")) cls = "del";
                  else if (ln.startsWith("@@")) cls = "hunk";
                  else if (ln.startsWith("diff ") || ln.startsWith("index ")) cls = "meta";
                  return (
                    <div key={i} className={`git-dl ${cls}`}>
                      {ln || " "}
                    </div>
                  );
                })}
              </pre>
            </>
          ) : (
            <div className="git-history">
              <div className="git-section-head">
                <span>{t.history}</span>
              </div>
              {log.map((c) => (
                <div key={c.hash} className="git-commit-row" title={c.hash}>
                  <span className="git-hash">{c.short}</span>
                  <span className="git-cmsg">{c.message}</span>
                  <span className="git-cmeta">
                    {c.author} · {c.date}
                  </span>
                </div>
              ))}
              {log.length === 0 && <div className="git-clean">{t.selectFile}</div>}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="git-toast" onClick={clearToast}>
          {toast}
        </div>
      )}
      {promptNode}
      {confirmNode}
    </div>
  );
}
