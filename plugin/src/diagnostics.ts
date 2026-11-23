// Local-only diagnostics. Never pass free-form messages or note identifiers to disk.
import { isRecord, isUnknownArray, isNonNegativeInteger } from "./validation.ts";
const EVENTS = new Set(["session_start", "session_stop", "previous_session_unclean", "marker_invalid", "sync_start", "sync_result", "sync_failure", "sync_exception", "startup_failure", "status_failure", "token_failure", "api_failure", "global_error", "unhandled_rejection", "queue_overflow"]);
const OPERATIONS = new Set(["scan", "pull", "push", "save"]);
const CATEGORIES = new Set(["error", "type", "range", "syntax", "reference", "api", "conflict", "unknown"]);
const CODES = new Set(["ENOSPC", "EACCES", "EPERM", "ENOENT", "EIO", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"]);
const COUNT_FIELDS = ["pulled", "pushed", "conflicts", "failed", "pending", "dropped"];
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;
const count = (value: unknown): value is number => isNonNegativeInteger(value) && value <= 1e9;
const version = (value: unknown): string => typeof value === "string" && /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(value) ? value : "unknown";
type Row = Record<string, unknown>;
export interface DiagnosticAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<unknown>;
  stat(path: string): Promise<{size: number} | null>;
  read(path: string): Promise<string>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  write(path: string, text: string): Promise<unknown>;
}
interface Options {
  pluginDir: string;
  pluginVersion?: string;
  obsidianVersion?: string;
  platform?: string;
  onFailure?: () => void;
}

// Parse source locations, not function names or error-message text. Unknown
// throwing locations deliberately prevent global attribution to this plugin.
function stackLocations(stack: unknown): {own: boolean; line: number; column: number}[] {
  if (typeof stack !== "string") return [];
  const locations: {own: boolean; line: number; column: number}[] = [];
  for (const [index, line] of stack.slice(0, 8192).split("\n").entries()) {
    // Only the leading error header is exempt from frame-boundary checks.
    if (index === 0 && /^\s*(?:Error|[A-Za-z]+Error):/.test(line)) continue;
    // Recognize frame boundaries more broadly than supported source syntax.
    // A whitespace-containing @-style frame must block later caller attribution.
    if (!/^\s*at\s/.test(line) && !/^[^@]*@/.test(line)) continue;
    const frame = /^\s*at\s+(?:.*\s\()?([^\s()]+):(\d{1,8}):(\d{1,8})\)?\s*$/.exec(line)
      ?? /^[^\s@]*@([^\s()]+):(\d{1,8}):(\d{1,8})\s*$/.exec(line);
    if (!frame) { locations.push({own:false,line:0,column:0}); continue; }
    locations.push({own:ownSource(frame[1]), line:Number(frame[2]), column:Number(frame[3])});
  }
  return locations;
}
function ownSource(source: string): boolean {
  return /^(?:plugin:distributed-sync|(?:app:\/\/[^\s]+\/)?\.obsidian\/plugins\/distributed-sync\/main\.js)$/.test(source);
}
export function pluginFrames(stack: unknown): {line: number; column: number}[] {
  return stackLocations(stack).filter(f => f.own).slice(0, 5).map(f => ({line:f.line,column:f.column}));
}
export function safeError(error: unknown): Row {
  try {
    const e = error as {name?: unknown; code?: unknown; status?: unknown; stack?: unknown} | null;
    const names: Record<string, string> = {Error:"error", TypeError:"type", RangeError:"range", SyntaxError:"syntax", ReferenceError:"reference", ApiError:"api", ConflictError:"conflict"};
    const row: Row = {category: typeof e?.name === "string" ? names[e.name] ?? "unknown" : "unknown"};
    if (typeof e?.code === "string" && CODES.has(e.code)) row.code = e.code;
    if (Number.isInteger(e?.status) && Number(e?.status) >= 400 && Number(e?.status) <= 599) row.status = e?.status;
    const frames = pluginFrames(e?.stack);
    if (frames.length) row.frames = frames;
    return row;
  } catch { return {category:"unknown"}; }
}
function fields(input: Row): Row {
  const out: Row = {};
  for (const key of COUNT_FIELDS) if (count(input[key])) out[key] = input[key];
  if (typeof input.operation === "string" && OPERATIONS.has(input.operation)) out.operation = input.operation;
  if (typeof input.category === "string" && CATEGORIES.has(input.category)) out.category = input.category;
  if (typeof input.code === "string" && CODES.has(input.code)) out.code = input.code;
  if (Number.isInteger(input.status) && Number(input.status) >= 400 && Number(input.status) <= 599) out.status = input.status;
  if (isUnknownArray(input.frames)) {
    out.frames = input.frames.slice(0, 5).flatMap(frame =>
      isRecord(frame) && count(frame.line) && count(frame.column)
        ? [{line:frame.line, column:frame.column}] : []);
  }
  return out;
}

function validatedRow(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Row;
  if (r.schema !== 1 || !Number.isSafeInteger(r.time) || Number(r.time) < 0 || typeof r.event !== "string" || !EVENTS.has(r.event)) return null;
  if (typeof r.session !== "string" || !/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|unknown)$/.test(r.session)) return null;
  if (typeof r.platform !== "string" || !["desktop", "mobile", "unknown"].includes(r.platform)) return null;
  if ((r.pluginVersion !== "unknown" && version(r.pluginVersion) === "unknown") || (r.obsidianVersion !== "unknown" && version(r.obsidianVersion) === "unknown")) return null;
  const buildSha256 = typeof r.buildSha256 === "string" && /^[a-f0-9]{64}$/.test(r.buildSha256) ? r.buildSha256 : "unknown";
  return {schema:1, time:r.time, session:r.session, pluginVersion:r.pluginVersion, obsidianVersion:r.obsidianVersion, platform:r.platform, buildSha256, event:r.event, ...fields(r)};
}

function sessionId(): string {
  try { return crypto.randomUUID(); } catch { return "unknown"; }
}

export class LocalDiagnostics {
  private readonly session = sessionId();
  private readonly options: Options;
  private queue: string[] = [];
  private running: Promise<void> | null = null;
  private current = "";
  private failed = false;
  private dropped = 0;
  private stopped = false;
  private closePromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private initializing = false;
  private skippedRecords = 0;
  private buildSha256 = "unknown";
  private detachGlobals: (() => void) | null = null;
  private readonly adapter: DiagnosticAdapter;
  private readonly diagnosticsDir: string;
  constructor(adapter: DiagnosticAdapter, options: Options) {
    this.adapter = adapter;
    this.options = options;
    this.diagnosticsDir = `${options.pluginDir}/diagnostics`;
  }
  private warn(): void {
    if (!this.failed) {
      this.failed = true;
      try { this.options.onFailure?.(); } catch { /* UI cannot affect sync. */ }
    }
  }
  private row(event: string, data: Row): Row {
    return {schema:1, time:Date.now(), session:this.session, pluginVersion:version(this.options.pluginVersion), obsidianVersion:version(this.options.obsidianVersion), platform:["desktop", "mobile"].includes(this.options.platform ?? "") ? this.options.platform : "unknown", buildSha256:this.buildSha256, event, ...fields(data)};
  }
  log(event: string, data: Row = {}): void {
    try {
      if (this.stopped || !EVENTS.has(event)) return;
      if (this.queue.length >= 128) { this.dropped = Math.min(this.dropped + 1, 1e9); return; }
      this.queue.push(JSON.stringify(this.row(event, data)) + "\n");
      this.kick();
    } catch { this.warn(); }
  }
  private kick(): void {
    if (this.running || this.initializing) return;
    this.running = Promise.resolve().then(() => this.drain()).catch(() => this.warn()).finally(() => {
      this.running = null;
      if (this.queue.length || this.dropped) this.kick();
    });
  }
  private async drain(): Promise<void> {
    while (this.queue.length || this.dropped) {
      const batch = this.queue.splice(0);
      if (this.dropped) { batch.push(JSON.stringify(this.row("queue_overflow", {dropped:this.dropped})) + "\n"); this.dropped = 0; }
      for (const line of batch) {
        try {
          if (bytes(this.current) + bytes(line) > 256 * 1024) {
            await this.adapter.write(`${this.diagnosticsDir}/previous.jsonl`, this.current);
            this.current = "";
          }
          const next = this.current + line;
          await this.adapter.write(`${this.diagnosticsDir}/current.jsonl`, next);
          this.current = next;
        } catch { this.warn(); }
      }
    }
  }
  async flush(): Promise<void> {
    if (this.initializing) await this.startPromise;
    while (this.running) await this.running;
  }
  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.startPromise) {
      this.initializing = true;
      this.startPromise = this.initialize().catch(() => this.warn()).finally(() => {
        this.initializing = false;
        if (this.queue.length || this.dropped) this.kick();
      });
    }
    return this.startPromise;
  }

  private async initialize(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.diagnosticsDir))) await this.adapter.mkdir(this.diagnosticsDir);
    } catch { this.warn(); }
    await this.identifyBuild();
    const old = await this.readBounded("current.jsonl", 256 * 1024);
    if (old !== null) {
      const lines = this.parseRows(old).map(r => JSON.stringify(r) + "\n");
      let size = lines.reduce((total, line) => total + bytes(line), 0);
      while (size > 256 * 1024) { size -= bytes(lines.shift()!); this.skippedRecords++; }
      this.current = lines.join("");
    }
    const marker = await this.readBounded("session.json", 256);
    if (marker !== null) {
      try {
        const state: unknown = JSON.parse(marker);
        if (!isRecord(state) || state.schema !== 1 || (state.state !== "open" && state.state !== "closed")) throw new Error();
        if (state.state === "open") this.log("previous_session_unclean");
      } catch { this.log("marker_invalid"); }
    }
    try { await this.adapter.write(`${this.diagnosticsDir}/session.json`, JSON.stringify({schema:1,state:"open"})); } catch { this.warn(); }
    this.initializing = false;
    this.log("session_start");
    this.kick();
    await this.flush();
  }

  private async readBounded(name: string, cap: number): Promise<string | null> {
    try {
      const path = `${this.diagnosticsDir}/${name}`;
      const stat = await this.adapter.stat(path);
      if (stat === null) return null;
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > cap) { this.warn(); this.skippedRecords++; return null; }
      const text = await this.adapter.read(path);
      if (typeof text !== "string" || bytes(text) > cap) { this.warn(); this.skippedRecords++; return null; }
      return text;
    } catch { this.warn(); return null; }
  }

  private parseRows(text: string): Row[] {
    const rows: Row[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        if (bytes(line) > 8192) throw new Error();
        const row = validatedRow(JSON.parse(line));
        if (!row) throw new Error();
        rows.push(row);
      } catch { this.skippedRecords++; }
    }
    return rows;
  }

  private async identifyBuild(): Promise<void> {
    // Read the installed bytes, not Git HEAD (the working tree may be dirty).
    try {
      if (!this.adapter.readBinary) return;
      const path = `${this.options.pluginDir}/main.js`;
      const stat = await this.adapter.stat(path);
      if (!stat || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > 4 * 1024 * 1024) return;
      const data = await this.adapter.readBinary(path);
      if (data.byteLength > 4 * 1024 * 1024 || data.byteLength !== stat.size) return;
      this.buildSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), b => b.toString(16).padStart(2, "0")).join("");
    } catch { /* Build identity is explicitly unknown when unavailable. */ }
  }

  async export(): Promise<{path: string | null; unavailable: boolean}> {
    await this.flush();
    const rows: Row[] = [];
    let used = 0;
    for (const name of ["previous.jsonl", "current.jsonl"]) {
      const text = await this.readBounded(name, 256 * 1024);
      if (text === null) continue;
      for (const row of this.parseRows(text)) {
        const size = bytes(JSON.stringify(row)) + 1;
        if (used + size > 512 * 1024) { this.skippedRecords++; continue; }
        rows.push(row); used += size;
      }
    }
    const path = `${this.diagnosticsDir}/export.json`;
    try {
      await this.adapter.write(path, JSON.stringify({schema:1, exportTime:Date.now(), buildSha256:this.buildSha256, diagnosticsUnavailable:this.failed, skippedRecords:this.skippedRecords, events:rows}));
      return {path, unavailable:this.failed};
    } catch { this.warn(); return {path:null, unavailable:true}; }
  }

  attachGlobalHandlers(target: Partial<Pick<Window, "addEventListener" | "removeEventListener">>): void {
    if (this.detachGlobals || !target.addEventListener || !target.removeEventListener) return;
    const capture = (event: Event): void => {
      try {
        const e = event as ErrorEvent & PromiseRejectionEvent;
        const error: unknown = event.type === "unhandledrejection" ? e.reason : e.error;
        const safe = safeError(error);
        const filename = typeof e.filename === "string" ? e.filename : "";
        const ownFile = ownSource(filename);
        const ownThrow = stackLocations(isRecord(error) ? error.stack : undefined)[0]?.own === true;
        if (filename ? !ownFile : !ownThrow) return;
        if (!safe.frames && ownFile && count(e.lineno) && count(e.colno)) safe.frames = [{line:e.lineno,column:e.colno}];
        this.log(event.type === "unhandledrejection" ? "unhandled_rejection" : "global_error", safe);
      } catch { /* Do not propagate another listener's exception. */ }
    };
    target.addEventListener("error", capture);
    target.addEventListener("unhandledrejection", capture);
    this.detachGlobals = () => {
      target.removeEventListener?.("error", capture);
      target.removeEventListener?.("unhandledrejection", capture);
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.detachGlobals?.();
    this.detachGlobals = null;
    this.log("session_stop");
    this.stopped = true;
    this.closePromise = (async () => {
      await this.startPromise;
      await this.flush();
      if (!this.failed) {
      try { await this.adapter.write(`${this.diagnosticsDir}/session.json`, JSON.stringify({schema:1,state:"closed"})); } catch { this.warn(); }
      }
    })();
    return this.closePromise;
  }
}
