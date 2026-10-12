# Distributed Obsidian Sync System

A reliable, privacy-focused distributed synchronization system for Obsidian vaults powered by **Cloudflare Workers + D1 (SQLite) + R2 (Object Storage)** and an **Obsidian plugin**.

---

## Architecture Summary

```
Obsidian Desktop / Mobile             Cloudflare Edge              Storage Backends
┌─────────────────────────┐     HTTPS     ┌───────────────────┐        ┌─────────────┐
│  Obsidian Plugin        │──────────────▶│ Cloudflare Worker │───────▶│ D1 (SQLite) │
│  - Myers Diff3 (Line)   │               │ - /v1/* REST API  │        │ - Files     │
│  - CAS State Index      │◀──────────────│ - Bearer Auth     │        │ - Revisions │
│  - Conflict Preserver   │ 200 OK / 409  │ - Monotonic Log   │        │ - Tokens    │
└─────────────────────────┘               └─────────┬─────────┘        └─────────────┘
                                                    │                  ┌─────────────┐
                                                    └─────────────────▶│  R2 Bucket  │
                                                                       │ (SHA Blobs) │
                                                                       └─────────────┘
```

### Core Design Rules
- **No data loss ever**: The server never silently overwrites files. Atomic compare-and-swap checks `base_rev`.
- **Content-addressed deduplication**: R2 stores blobs keyed by `blobs/<sha256[:2]>/<sha256>`. Duplicate uploads across devices do not take extra storage or advance the monotonic log.
- **Three-way merge**: Non-overlapping text edits converge cleanly without user interaction using Myers $O(ND)$ line-diff.
- **Conflict branching**: Overlapping text collisions and binary edits (Images, PDF, Canvas) preserve the local file and save the remote version into a sibling file:
  `Note (conflict <device> YYYY-MM-DD HH.mm).md`
- **Edit beats delete**: When a device edits a note offline while another device deleted it, the edited note is restored and preserved.
- **Edit follows rename**: Renames are first-class atomic metadata operations with tombstones for old paths.

---

## Repository Structure

- `server/`: Cloudflare Worker, D1 schema, and R2 blob storage implementation.
- `plugin/`: Obsidian community plugin with client-side diff3 engine, local index, and UI.
- `test/`: In-process test harness running real Worker code against `node:sqlite` (D1) and in-memory R2 with 10 end-to-end multi-device sync scenarios.

---

## Quickstart & Verification

```bash
# 1. Typecheck both server and plugin
npm run check

# 2. Build plugin bundle (main.js)
npm run build

# 3. Run full multi-device sync simulation test suite
npm test
```

### Test Suite Results

```text
✔ Scenario 1: Single device create, edit, rename, delete roundtrip (52.5ms)
✔ Scenario 2: Multi-device sync across two devices (10.2ms)
✔ Scenario 3: Two devices edit different files simultaneously -> automatic merge (10.5ms)
✔ Scenario 4: Two devices edit disjoint lines in the same note -> clean 3-way merge (12.4ms)
✔ Scenario 5: Two devices edit the same line -> conflict detected, sibling conflict file created, ZERO data lost (12.7ms)
✔ Scenario 6: Delete vs Edit race -> Edit beats delete (8.9ms)
✔ Scenario 7: Rename vs Edit race -> Rename preserved with edit (15.5ms)
✔ Scenario 8: Binary file conflict (Canvas / PDF / Image) -> sibling conflict copies, never corrupted (9.1ms)
✔ Scenario 9: Idempotent duplicate write -> identical content does not advance seq (4.5ms)
✔ Scenario 10: Old device returns after months and catches up (38.1ms)

ℹ tests 10 | pass 10 | fail 0 | cancelled 0
ℹ duration_ms 182.1ms
```

---

## Deployment to Cloudflare

### Step 1: Deploy Cloudflare Worker & Storage
```bash
# 1. Login to Cloudflare
npx wrangler login

# 2. Create the D1 Database
npx wrangler d1 create obsidian-sync-db
# Copy the database_id into server/wrangler.jsonc

# 3. Create the R2 Bucket
npx wrangler r2 bucket create obsidian-sync-blobs

# 4. Initialize Database Schema
npx wrangler d1 execute obsidian-sync-db --file=./server/schema.sql

# 5. Deploy the Worker
cd server && npx wrangler deploy
```

### Step 2: Mint a Device Token
```bash
curl -X POST https://<your-worker-subdomain>.workers.dev/v1/tokens \
  -H "Content-Type: application/json" \
  -d '{"name": "Laptop"}'
```

### Step 3: Configure Obsidian Plugin
1. Copy `plugin/manifest.json` and `plugin/main.js` into your vault:
   `<YourVault>/.obsidian/plugins/obsidian-distributed-sync/`
2. Enable **Distributed Sync** in Obsidian Community Plugins.
3. In settings, enter your **Server URL** and **Device Token**.
