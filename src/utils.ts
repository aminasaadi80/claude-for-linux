// Small pure helpers shared across panels.

/** Quote a filesystem path for pasting into a shell when it contains spaces. */
export function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

export function isImage(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
}

/** Parent of a unix-style path ("/a/b" → "/a"; the root stays "/"). */
export function parentPath(p: string): string {
  if (p === "/" || !p) return "/";
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Last segment of a unix-style path. */
export function baseName(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

/** Human-readable file size ("—" for directories). */
export function fmtSize(n: number, isDir: boolean): string {
  if (isDir) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Locale-formatted time from unix epoch seconds ("" for 0/unknown). */
export function fmtTime(secs: number): string {
  if (!secs) return "";
  try {
    return new Date(secs * 1000).toLocaleString();
  } catch {
    return "";
  }
}
