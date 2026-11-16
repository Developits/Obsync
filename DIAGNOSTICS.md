# Local sync diagnostics

Distributed Sync keeps **local-only** troubleshooting records by default. There is no diagnostics endpoint, background upload, third-party telemetry SDK, or automatic sharing. Normal sync requests still go only to your configured sync server; diagnostics do not add requests.

## Exporting a report

Run **Distributed Sync: Export local diagnostics** from the command palette, or click **Export diagnostics** in the plugin's settings. A notice shows the vault-relative output location:

```
.obsidian/plugins/obsidian-distributed-sync/diagnostics/export.json
```

Review that file before manually attaching it to a bug report. Export overwrites the same file; it does not create an ever-growing collection. A failed export is explicitly reported. An incomplete export has `diagnosticsUnavailable: true` and a warning notice; it must not be treated as a complete record.

The **Local diagnostics** toggle disables new collection and removes global error listeners. It does not delete existing logs. Re-enable it before exporting through the plugin. To remove retained reports, disable diagnostics and delete this plugin's `diagnostics` directory with your file manager. These files are not encrypted: anyone with access to the vault's configuration directory can read them. Third-party vault backups or other sync tools may copy them even though this plugin excludes `.obsidian` unconditionally.

## What is recorded

A strict schema allows only:

- Schema number, timestamp, random session identifier, plugin/Obsidian numeric versions or `unknown`, and desktop/mobile/unknown platform.
- `buildSha256`: SHA-256 of the exact installed `main.js` bytes, computed at session startup using Obsidian's DataAdapter and WebCrypto. The bundle is stat-checked before a read and limited to 4 MiB. Missing APIs, a missing/oversized/unreadable bundle, or a size change yield explicit `unknown`, never a Git revision substituted for the running build. Each newly collected row carries its session's fingerprint; export-level metadata identifies the current session's bundle. Manifest version alone does not identify a repaired build. Older imported rows without a fingerprint are marked `unknown`.
- Known lifecycle, sync, API, startup/status/token-failure and attributable global-error event names.
- Nonnegative bounded sync counts (pulled, pushed, conflicts, failed, pending), operation enums (scan/pull/push/save), and queue-overflow counts.
- Allowlisted error categories, known OS error codes, HTTP error status numbers, and up to five numeric line/column pairs from this plugin's bundle. Global errors/rejections require this plugin's throwing source or its ErrorEvent filename; another plugin's throwing frame above this plugin's caller is excluded. Unsupported/ambiguous stack formats are deliberately not captured globally.

**Never written:** note content or names, raw/hashed note paths, device names, server URLs, tokens, settings, request/response bodies, arbitrary error messages, complete stacks, or function names. Per-operation failures returned by the engine expose only an operation and `unknown` category because the engine's free-form failure text is intentionally not parsed or retained. API/status/token failures can separately retain safe categories/statuses.

Export parses and revalidates the two fixed log files rather than concatenating their bytes. Unknown fields are stripped, invalid/truncated records are skipped, and `skippedRecords` reports a cumulative skip count for this logger session. Externally edited logs are not trusted or authenticated; sharing an export does not certify that every allowed count or timestamp is genuine.

## Bounds and failure behavior

All files live beneath the fixed diagnostics directory, outside this plugin's sync selection:

| File | Bound |
| --- | --- |
| `current.jsonl` | 256 KiB UTF-8 |
| `previous.jsonl` | 256 KiB UTF-8 |
| `export.json` | 512 KiB of serialized event rows plus at most 4 KiB metadata/JSON overhead |
| `session.json` | A small open/closed marker; reads capped at 256 bytes |

Only the current and previous log generations are kept. Writes are serialized. The pending queue holds at most 128 bounded rows, with at most one additional bounded in-flight batch; excess events are counted in a coalesced `queue_overflow` record instead of allocating an unbounded queue. Rotation and restart reconstruction use UTF-8 byte lengths, not JavaScript character counts. Log reads are stat-checked before reading at a 256 KiB cap and checked again after reading. The DataAdapter has no atomic stat-and-bounded-read primitive: an unrelated external writer replacing a file between stat and read is outside that pre-read guarantee.

Diagnostics use the cross-platform Obsidian adapter, not Node filesystem APIs. No additional interval or timeout is installed. Disk/read/stat failures (including full disks) are caught, give one sanitized notice per logger session, and flag exports as unavailable/incomplete. They do not change a sync result or clear pending work. Normal sync waits for its diagnostic flush after determining its result; slow local storage may therefore delay completion. Like other adapter operations, a permanently unresolved filesystem promise cannot be timed out without an additional timer.

## Crash-context limits

An open marker is written at startup and a closed marker after an orderly best-effort shutdown flush. On the next startup an open marker records `previous_session_unclean`. This means only that a successful shutdown marker was not observed: forced termination, a power loss, diagnostics I/O failure, or an application reload interruption can all cause it. **It is not proof of a crash.** Corrupt markers are reported separately and are not called crashes.

Attributable browser errors and unhandled rejections are captured while listeners are attached. This is not a native crash reporter and cannot capture renderer/OS crashes, earlier initialization failures before diagnostics starts, or guarantee a final write during hard termination. A last partial JSONL record may be skipped at export. Session-stop/closed-marker writes during plugin unload are best effort because Obsidian need not await asynchronous unload work.
