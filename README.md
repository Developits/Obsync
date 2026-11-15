# Distributed Obsidian Sync System

An Obsidian sync plugin with a Cloudflare Worker API, D1 metadata and R2 content storage. This is self-hosted software, not a replacement for independent backups. Start with disposable vaults and a staging backend before trusting personal notes to a new build.

## Architecture and safety model

- The plugin reconciles local file changes with server revisions over HTTPS.
- Server mutations conditionally check `base_rev` inside a D1 transaction. Metadata, revision records and sequence publication are batched together; rejected attempts may leave harmless sequence gaps.
- R2 blobs are content-addressed by SHA-256. `/v1/changes` is a latest-state delta feed, not an immutable event log.
- Only consumed pull pages advance the client checkpoint. A write acknowledgment does not establish that intervening remote changes were consumed.
- Markdown uses three-way line merges. Overlapping edits and binary changes create separate conflict files. Repeated conflicts must not overwrite existing copies.
- Directories are derived from file paths. Empty folders are not synchronized. Folder renames are translated into per-file operations.
- `.obsidian`, `.trash`, `.git` and internal index paths are excluded; this does not synchronize Obsidian settings, plugins or themes. Do not put device credentials in synchronized files.
- Encryption in transit is HTTPS. There is no client-side end-to-end encryption: the backend can read the uploaded note and attachment bytes.
- Sync runs while Obsidian and the plugin are running. Android may suspend Obsidian; this is not an OS-level always-on background service.
- Conflict files and server revisions are recovery aids, not backups. Do not purge tombstones/history while offline devices might still need them.

## Development and verification

The tests require Node with built-in `node:sqlite` and TypeScript stripping. The recorded repair audit used Node 26.12.1; CI uses a supported Node release with those features. Install both subprojects' dependencies:

```sh
npm ci --prefix server --ignore-scripts
npm ci --prefix plugin --ignore-scripts
npm run check
npm run build
npm test
npm run package
```

The regression tests cover concurrent mutations, offline edits, renames, conflict preservation and plugin lifecycle behavior. Read the actual test output rather than relying on a historical count or timing printed in this README. Mocked adapters do not establish native Obsidian or Android correctness; native and staging checks are separate release gates.

### Optional actual local Worker check

From the repository root, with Wrangler installed:

```sh
npx wrangler d1 execute obsidian-sync-db --local --file server/schema.sql --config server/wrangler.jsonc --persist-to .local-sync-test
npx wrangler dev --local --ip 127.0.0.1 --port 8787 --config server/wrangler.jsonc --persist-to .local-sync-test --var API_KEY:qa-only-bootstrap-fixture
```

In a second terminal:

```sh
node test/workerd-smoke.mjs
```

That script refuses non-loopback targets, uses only disposable fixtures, and checks authenticated enrollment plus PUT/PUT, PUT/DELETE and rename/destination races on actual local workerd/D1/R2. The visible fixture key above is not a production credential. Never reuse it for a public deployment. Local state and generated device tokens must not be committed.

## Deploy a new staging backend

Do not run resource-creation or schema commands against an existing deployment without first checking its resources and backups. The repository configuration contains a database ID; replace it with the intended staging database ID rather than assuming it belongs to your account.

```sh
cd server
npm ci --ignore-scripts
npx wrangler login
npx wrangler d1 create obsidian-sync-db
# Update database_id in wrangler.jsonc to the database you just created.
npx wrangler r2 bucket create obsidian-sync-blobs
npx wrangler d1 execute obsidian-sync-db --remote --file=./schema.sql
npx wrangler secret put API_KEY
npx wrangler deploy
```

`wrangler secret put API_KEY` prompts locally for a strong bootstrap secret. Never commit it, paste it into a bug report or use the test fixture value. An empty token database no longer permits unauthenticated enrollment. Without a configured bootstrap secret, initial enrollment is denied.

### Enroll the first device

Use the new deployment's Worker URL. Enter the same bootstrap secret locally into an environment variable without exposing it in shell history:

```sh
read -r -s -p 'Bootstrap secret: ' OBSYNC_BOOTSTRAP_KEY; printf '\n'
curl --fail-with-body -X POST 'https://YOUR-WORKER.workers.dev/v1/tokens' \
  -H 'Content-Type: application/json' \
  -H "X-Api-Key: $OBSYNC_BOOTSTRAP_KEY" \
  -d '{"name":"Laptop"}'
unset OBSYNC_BOOTSTRAP_KEY
```

The response contains a sensitive device token: keep it private. Existing authorized devices can enroll another device through the plugin's settings; device tokens therefore grant enrollment authority as well as vault access. This version does not introduce a separate administrator role or a revocation UI.

### Install into a test vault

1. Build the plugin and copy `plugin/manifest.json` and `plugin/main.js` into `YOUR-TEST-VAULT/.obsidian/plugins/obsidian-distributed-sync/`.
2. Enable Distributed Sync in Community Plugins.
3. Enter the HTTPS Server URL, Device Token and a distinct Device Name.
4. Test create/edit/rename/delete in both directions, offline conflicts, attachments and restart recovery before using a real vault.
5. Keep an independent backup, choose the authoritative initial vault copy deliberately, and use only one sync mechanism on those same files.

Cloud deployment, a green unit suite and a successful health probe do not by themselves prove that all devices synchronize correctly.
