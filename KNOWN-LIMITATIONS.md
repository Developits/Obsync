# Known limitations of the 1.0.1 repair candidate

The original audit's 13 issue groups have repairs and regression coverage. That is a bounded acceptance claim, not proof that every possible sync interleaving is correct. Independent reviews passed the audited changes but recorded the following legacy behaviors and unverified cases.

## Non-blocking legacy behaviors reported by independent review

- A queued local rename can encounter a different remote file at its intended destination. The existing reconciliation policy may replace the local destination/rename intent while retaining recoverable bytes at the old server path and/or a conflict copy. The reviewer reproduced this on both the original base and the repaired snapshot; it is not certified as a clean identity-preserving rename.
- A remote rename into a destination excluded by another device may remove that device's old local path without creating a local artifact; the remote bytes remain at the excluded destination. This differs from a LOCAL move into an excluded path, whose accidental remote deletion is fixed and tested.
- One narrow semantic rename-conflict branch can retain a historical base_path while advancing a destination revision. The reviewer identified this by inspection, not a demonstrated new loss case. Broader rename-lineage tests are still appropriate.
- Corrupt local index recovery and interrupted state-save/mutation races need additional fault-injection/restart coverage. Current load behavior can reset an unreadable index; the new save-failure reporting does not claim to solve arbitrary state-file corruption.

These are disclosed follow-up items, not silently reclassified as passing test scenarios. Until they are addressed or explicitly accepted as policy, use a staging vault and independent backups rather than a primary-vault rollout.

## Deliberate scope and policy boundaries

- Folder structure is derived from file paths; empty folders are not synchronized.
- .obsidian and other excluded paths do not synchronize. Device credentials are local and must remain excluded.
- Uncertain rename lineage may be preserved as independent branches instead of guessing file identity.
- Conflict name reservations protect concurrent operations within one SyncEngine. They are not OS-level exclusive creation against unrelated processes or multiple independent engines.
- The server uses one shared vault/access domain. Device tokens can enroll peers. No separate admin role, device-revocation UI or client-side end-to-end encryption was added.
- Rejected uploads can leave content-addressed R2 blobs; garbage collection and complete retention/purge semantics were not redesigned.
- Local workerd/D1/R2, in-process tests and native Linux Obsidian checks do not establish cloud-staging, Android suspension/resume or S Pen PDF annotation behavior. Those acceptance gates remain unperformed.
- CI is configured and locally simulated; no remote Actions run, tag publication, Cloudflare deployment or installation into Nebulae occurred.

Do not push the historical v1.0.0 tag expecting these fixes. Version 1.0.1 is the new local repair candidate; old release history is preserved.
