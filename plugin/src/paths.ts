// Path utilities, normalization, and conflict file naming.

export function normalizePath(path: string): string {
  // Normalize unicode to NFC (critical for cross-platform macOS/Windows/Android compatibility)
  return path.normalize("NFC").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function encodePath(path: string): string {
  return encodeURIComponent(normalizePath(path));
}

export function isIgnored(path: string, customExcludes: string[] = []): boolean {
  const norm = normalizePath(path);
  const defaultExcludes = [
    ".obsidian",
    ".trash",
    ".git",
    ".index",
    ".DS_Store",
    "desktop.ini",
  ];

  for (const exc of defaultExcludes) {
    if (norm === exc || norm.startsWith(exc + "/")) {
      return true;
    }
  }

  for (const exc of customExcludes) {
    const trimmed = normalizePath(exc);
    if (!trimmed) continue;
    if (norm === trimmed || norm.startsWith(trimmed + "/")) {
      return true;
    }
  }

  return false;
}

export function generateConflictPath(path: string, deviceName: string, date: Date = new Date()): string {
  const norm = normalizePath(path);
  const lastSlash = norm.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : norm.slice(0, lastSlash);
  const filename = lastSlash === -1 ? norm : norm.slice(lastSlash + 1);

  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? "" : filename.slice(dot);

  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());

  const safeDevice = (deviceName || "device").replace(/[/\\?%*:|"<>]/g, "_");
  const conflictName = `${stem} (conflict ${safeDevice} ${yyyy}-${mm}-${dd} ${hh}.${min})${ext}`;

  return dir ? `${dir}/${conflictName}` : conflictName;
}
