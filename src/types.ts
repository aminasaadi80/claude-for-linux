import type { RemoteConfig } from "./RemotePanel";
import type { SshConfig } from "./Terminal";

export type Role = "user" | "assistant";
export type Perm = "default" | "acceptEdits" | "bypassPermissions";
export type Theme = "dark" | "light";
export type TabKind = "chat" | "terminal" | "git" | "remote" | "ssh";

export interface Message {
  role: Role;
  content: string;
  streaming?: boolean;
  error?: boolean;
  kind?: "tool";
}

export interface Usage {
  input: number;
  output: number;
}

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  /** remote (SFTP/FTP) tabs: the connection draft for this tab */
  remote?: RemoteConfig;
  /** ssh tabs: the connection draft for this tab */
  ssh?: SshConfig;
  /** git tabs: optional per-tab proxy for network ops (independent of app proxy) */
  gitProxy?: string;
  messages: Message[];
  cwd: string;
  sessionId?: string;
  permission: Perm;
  usage?: Usage;
  split?: boolean;
  restored?: boolean;
  /** terminal tabs: pass --dangerously-skip-permissions so Claude never stops
   * to ask (equivalent to "yes" / "yes, always" on every prompt) */
  skipPermissions?: boolean;
  /** terminal tabs: a dedicated claude session id so each tab restores its own
   * conversation on restart — even when several tabs share one project folder.
   * Absent on session-picker tabs (they attach to an externally chosen session)
   * and on legacy tabs saved before this existed. */
  termSession?: string;
}
