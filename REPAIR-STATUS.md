# Sequential repair checkpoints

## Current edge-case follow-up (supersedes historical rollout gates below)

Branch: `fix/edge-case-validation`, based on `a40d1dd3c92c79d1e866590223bd8b9916792d0b`. The earlier audit/checkpoints below are preserved as history, not current deployment claims.

The reproduced client and Worker roots were repaired sequentially with per-root RED/GREEN and baseline evidence. Independent client review found three additional recovery defects; those were reproduced, repaired and independently re-reviewed successfully. Current validation: 143/143 automated tests, 32/32 replica stress scenarios, 46/46 actual local Worker scenarios, 33/33 isolated cloud-staging checks, and 21/21 native Linux Obsidian scenarios. Additional independent review probes: 90 Worker checks and 6 client checks passed. Typechecks and packaging pass; generated ZIP bytes match the native-tested bundle.

Evidence and source hashes: `/home/nahid/Obsync-fix-validation/`. Bundle SHA-256: `084df6be928a22f36226b2ebe4a0d3b0761d319be0ca4d4f1dead8d234745ae6`. No production deployment, primary-vault installation, commit/push or release was performed by this follow-up. Android and a backed-up original-vault pilot remain unperformed; compacted unobserved excluded-rename lineage and crash/filesystem trust bounds are explicitly documented in KNOWN-LIMITATIONS.md.

## Local diagnostics follow-up

The frozen diagnostics build passed independent review with no reported security concerns or logic errors, all 165 automated tests (zero skipped), both typechecks, and 33/33 native Linux Obsidian disposable-vault scenarios (12 sync baseline, 13 diagnostics, 8 supplementary). All three ZIPs contain the same verified bundle. Bundle SHA-256: `bdfd881155b8f2df696554d58509810add7e876c750719e644b1fef2adc33c36`.

Evidence: `/home/nahid/Obsync-telemetry-evidence/VALIDATION-STATUS.md`, `resumed-review/verdict.json`, and `resumed-native/REPORT.md`. The parent reran the native aggregate verifier successfully. Sync/index/backend algorithms remain unchanged from the preceding edge-case repair baseline. Privacy/export, attributed errors, lifecycle markers, injected storage faults and bounded flood checks passed within the recorded finite scope; some instrumentation probes use explicit renderer injection. Recurring autosync scheduling, mobile acceptance and an original-vault pilot are not certified by this follow-up. No production deployment or primary-vault installation was performed by this validation.

## Historical original repair checkpoints

Branch: fix/sync-data-safety
Base: 929dfe0c4e7673e62fb6d11d31456e959c5995b0
Scope: local source/test changes only. No production deployment or real-vault installation.

## Verified targeted checkpoints (final scoped reviews passed)

1. C1 offline edits across rename: audit-client A1/A1b/A2 changed from 3 failing to 3 passing; original 13 remained green.
2. N2 contiguous pull checkpoint: new injected remote-between-pull-and-push test failed then passed. Write replies no longer set last_seq; final pull consumes their sequences safely. Original 13 remained green.
3. N3 upload snapshot: edit-during-upload failed then passed after acknowledgment rechecks bytes; delete-during-upload control passed. Download interleaving is separately reproduced and still pending as of this checkpoint.
4. C5 same-minute conflict preservation: audit-client C1 failed then passed with collision suffix and independent dirty conflict entry. Original 13 remained green.
5. C6 offline modification detection: audit-client D1 failed then passed using content hashes; D2 control passes. Original 13 remained green.
6. C2 local deletion versus remote edit: audit-client B1/B2 failed then passed and original 13 remained green.
7. N1 directories: faithful EISDIR regression and plugin folder-rename handler regression both failed then passed. Directory metadata is derived from file paths; empty folders are not synchronized. Old folder index entries are removed; legacy remote directory markers are ignored. Original 13 remained green.
8. C3 follow remote rename: audit-client A3 failed then passed; merge bases keep their original path while reconciling the new destination. Original 13 remained green.
9. C4 divergent rename recovery: audit-client A4 failed then passed; semantic conflict is surfaced and preserved as an independently uploaded branch, not an endless hidden queue. Transport/auth failures remain queued. Original 13 remained green.
10. S1 bootstrap authorization: audit-auth failed then passed; an empty token database no longer bypasses the configured bootstrap secret. Test harness uses an explicit test-only key. Existing token enrollment remains supported. Original 13 remained green.

## Earlier pending items (superseded by validated checkpoints below)

- S2 server conditional atomicity: dedicated implementer owns server/src/db.ts and server-atomic tests. No parallel parent production edits while that checkpoint is in progress.
- N3 download/merge/destructive-write race coverage: added failing edit-during-download regression; fix remains pending.
- N4 honest pending/error reporting, including local index save failures.
- N5 automatic sync control/timer lifecycle.
- Independent review feedback and any acceptance gaps (rename lineage, folder/exclusion moves, conflict creation races).
- Wire all regressions into default tests/CI, update setup/security documentation, native Obsidian retest, build/package and final review.

Do not interpret earlier targeted-green checkpoints as final approval of the combined release. Every final claim must be bound to a stable final source snapshot and a full rerun after all writers finish.

## Client review blockers validated (2026-11-15, source snapshot 19:47 +08:00)

11. B1 reused rename source: rename ack removal is identity-guarded; tombstone removes local bytes only for the exact tracked predecessor identity. New/dirty/untracked bytes are preserved and revived. client-review B1 + control pass.
12. B2/C3 rename lineage: renamed_from is followed only for base_rev>0 with a recorded base hash equal to the advertised source hash. Untracked and mismatched bases are not adopted; preserved bytes are re-uploaded. client-review B2/C3 + B2 mismatch pass; audit-client A1/A2/A3/A4 stay green.
13. B3 excluded moves: moving into an excluded tree detaches tracking instead of leaving a dirty deletion; moving out is picked up by the safe scan. plugin-runtime B3 + remote-copy-survives pass.
14. N3 write guards: download snapshot, merge write, tombstone delete, and deletion-restore paths re-check local bytes before destructive writes. safety 5/5 (download edit) and client-review N3 merge-during-download pass.
15. M2 base pairing: base_path is cleared on destination acks/rev advances and preserved on local create/modify events; push reconciliation uses the original base path. client-review M2 x2 and plugin-runtime M2 x2 pass.
16. M1/N4 reporting: per-file scan/push failures no longer abort other paths; pull checkpoint advances only across handled entries; sync returns {pulled,pushed,conflicts,failed,pending,errors}; LocalIndex.save rejects; manual UI reports failed/pending. client-review M1/N4 x4 pass.
17. N5 timers: polling and startup sync obey autoSync, settings changes refresh timers, onunload clears interval/startup/debounce. plugin-runtime N5 x2 pass.
18. Initial conflict-create mock passed with an optional adapter.createBinary hook. Later native testing disproved the assumed exclusive semantics of Vault.createBinary; this checkpoint alone was insufficient and is superseded by checkpoint 21 below.

Snapshot results: client-review 12/12, plugin-runtime 8/8, safety 5/5, sync 13/13, audit-client 10/10, audit-auth 1/1, audit-server 8/8, server-atomic 5/5, plugin tsc/build clean. Evidence: client-fix-evidence.txt. Native Obsidian retest, packaging, CI wiring and a full rerun on the parent's final merged snapshot remain parent-owned.

## Parent-verified integrated checkpoints

19. S2 authoritative conditional D1 batches: mutation and revision rows share atomic sequence publication; missing source returns 409. Actual local workerd/D1/R2 passes 20 PUT/PUT, 10 PUT/DELETE and 10 rename/destination-create races, plus enrollment and CRUD checks. A further red/green test fixes the live-source conflict payload's incorrect deleted flag.
20. Sticky lineage: added a red/green regression showing that a previously known destination must not steal an independently reused source path. Remote rename-following is restricted to unknown destinations; the original rename audit remains green.
21. Native conflict concurrency: actual Obsidian demonstrated that Vault.createBinary is not exclusive. The new non-exclusive-adapter test failed, then passed after synchronous per-engine candidate reservations. The rebuilt native plugin preserves distinct first/second artifacts under parallel calls. This does not claim filesystem transactions against unrelated external processes.
22. Linux packaging: all three old .zip files were actually TAR archives. Added a failing regression, replaced tar with a deterministic standard-library ZIP writer and argv-based build subprocess. All three ZIPs now decompress correctly with independently checked CRCs and contain exactly the expected bundle/manifest.
23. Dependency audit: upgraded pinned esbuild, Wrangler and compatible Workers types. Both plugin and server npm audit return zero known vulnerabilities on the recorded run. A peer-dependency conflict was resolved by installing the compatible Workers types, not by forcing npm.
24. CI: default npm test now discovers every *.test.mjs regression. Validation workflow installs both projects, checks/builds/tests/audits/packages; release workflow validates before publication. These workflows are configured but have not run remotely because no branch was pushed.
25. Final local validation: 66 tests passed, zero failed; typecheck, package, both dependency audits and actual local Worker smoke pass. Twelve native acceptance scenarios pass on two fresh Obsidian 1.15.1 test vaults, with the installed bundle hash matching the packaged bundle. Source/bundle hashes and raw output are in /home/nahid/Obsync-repair-evidence/final-validation-summary.json.

26. Independent review: final client and server scoped reviews pass; the focused reservation review passes after reproducing its red control. Tooling review verified the ZIP writer, lockfiles and Node 24/26 execution. Its handoff findings are resolved by including every new source/test/workflow in the local commit and preparing version 1.0.1; the historical v1.0.0 tag is preserved, not moved or pushed. No remote release or CI run is claimed.

Remaining release gates: a cloud-staging deployment, Android/tablet testing and an explicitly backed-up primary-vault pilot. These were not performed. The independent reviews also recorded non-blocking legacy edge cases outside the original audited acceptance scenarios; see KNOWN-LIMITATIONS.md. No claim of universal data-loss prevention or OS-level filesystem transactions is made.
