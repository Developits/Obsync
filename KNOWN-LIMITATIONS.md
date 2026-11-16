# Known limitations of the edge-case repair candidate

This working-tree candidate is on `fix/edge-case-validation`, based on a40d1dd. It is not the same bytes as the previously deployed production Worker or a previously published 1.0.1 plugin. Version labels alone do not identify this build; use the validation manifest and bundle hashes.

## Reproduced defects repaired and revalidated

- Queued rename destinations are protected from incoming overwrite/deletion and premature upload until rename success or explicit conflict reconciliation. Both intended local bytes and unrelated remote destination bytes are preserved in the tested collision cases.
- Semantic rename conflict rebases the historical path/revision tuple together.
- An observed remote rename into an excluded destination records durable preservation intent and creates a visible, non-overwriting artifact before deleting the tracked source. Artifact-write failure leaves the source retryable; successful artifacts increment the conflict count.
- Index writes are serialized and mutation-version guarded. A save publishes identical backup/primary snapshots with persisted generations. Loading selects the newest valid snapshot, validates persisted fields, and fails closed if neither existing copy is usable. Recovery preserves queued intent and divergent historical-base bytes; failed recovery blocks dependent renames and durable per-entry progress prevents duplicates on ordinary retries.
- Worker single-range handling, JSON/object validation, strict numeric inputs, retention bounds/readback and safe relative canonical path publication have behavioral regression coverage. Retention is an integer from 0 through 36500 days. Invalid requests are rejected before metadata mutation.

All repaired roots passed scoped independent review, the 143-test automated suite, actual local Worker/D1/R2 testing, isolated Cloudflare staging, and native Linux fake-vault acceptance. Evidence: `/home/nahid/Obsync-fix-validation/`. These are bounded tests, not proof of every interleaving or device environment.

## Remaining policy and implementation boundaries

- The changes feed stores latest file states, not immutable rename history. A `source -> excluded -> excluded` chain completed before a receiver pulls can hide the original rename advertisement. The visible-artifact guarantee is limited to an observed advertisement; in the reproduced unobserved case bytes remain remotely available, but no visible local artifact is guaranteed.
- Storage durability follows successful adapter writes. No fsync, OS-level transaction or crash-atomic transaction spanning artifact creation and index persistence is claimed. Loss/corruption of both index snapshots fails closed; it cannot reconstruct arbitrary unjournaled operations.
- Server validation rejects newly published unsafe paths, but does not migrate historical unsafe keys. Client-side explicit vault-root confinement against hostile or historical remote path values remains a separate hardening concern; no filesystem-escape exploit was established or attempted.
- Folder structure is derived from file paths; empty folders are not synchronized. `.obsidian` and other exclusions do not synchronize. Credentials stay local and excluded.
- Uncertain lineage may become independently preserved branches. Conflict-name reservations protect one SyncEngine, not unrelated filesystem writers or multiple engines.
- The backend has one shared vault/access domain. Device tokens can enroll peers; no separate admin role, device-revocation UI or client-side end-to-end encryption was added.
- Rejected uploads can leave content-addressed R2 blobs. Garbage collection and complete retention/purge semantics were not redesigned.
- Native acceptance is Linux Obsidian 1.15.1. Android suspension/resume, phone/tablet filesystems and S Pen PDF annotation behavior remain untested.

## Rollout state

The repaired build was deployed only to the separate synthetic staging Worker `obsync-qa-20261115163850`. This repair task did not update production, install into Nebulae, push a branch/tag or publish a release. A backed-up original-vault pilot requires an explicit rollout step; do not infer it from passing fake-vault tests. Temporary cloud test resources remain because cleanup approval timed out; deletion was not retried.
