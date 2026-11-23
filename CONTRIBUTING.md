# Contributing to Distributed Sync

Thanks for helping improve a sync tool where preserving user data comes first.

## Development

Use Node.js 24 and npm (the same versions as CI). From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
npm run package
npm audit
```

`check` validates release metadata, runs type-aware ESLint (including the
recommended Obsidian rules, with zero warnings allowed), and typechecks the
plugin and Worker. `build` regenerates the tracked `plugin/main.js`.
`package` builds local ZIPs plus the loose installer assets in `dist/`.
Only `main.js` and `manifest.json` are uploaded to GitHub releases.

The root workspace lockfile is authoritative for CI. After dependency changes,
update it with npm and run a clean install to check reproducibility. The ESLint
dependency override selects a patched 17.x `eslint-plugin-n`, avoiding the
vulnerable transitive minimatch version pinned by the SDL rules package.

## Project layout

- `plugin/src/`: vault integration, sync engine, index persistence, settings, diagnostics.
- `server/src/`: Cloudflare Worker authentication, D1 metadata and R2 storage.
- `test/`: headless protocol, persistence, concurrency and bundled-plugin regressions.
- `scripts/`: metadata validation and deterministic release packaging.

## Changes and tests

1. Open an issue describing significant behavior or protocol changes before implementing them.
2. Make focused changes on a branch and add a regression test that fails without the fix.
3. Keep byte-preservation, conflict recovery, offline edits, renames, and deletion races covered.
4. Validate external JSON at runtime before using it as typed data. Do not replace
   validation with unchecked assertions or suppress lint rules to silence findings.
5. Run all commands above; include the results and any limitations in your PR.

Use a disposable vault and a staging Worker for manual tests. Follow the README
for backend setup; never point an experimental build at your only copy of a vault.
For integration changes, check both a default and a custom vault configuration
folder. Keep the legacy settings renderer working on the declared minimum app
version, and check searchable settings on 1.13+.

The optional `npm run test:worker` exercises the real Worker runtime; inspect
`test/workerd-smoke.mjs` for its tooling requirements before running it.

## Bug reports and privacy

Include plugin/app versions, operating system, whether mobile is involved,
minimal reproduction steps, and expected versus actual results. Use synthetic
notes. Never attach device tokens, bootstrap keys, private note contents, or a
whole vault. Review exported diagnostics before sharing them.

For security vulnerabilities, use GitHub private vulnerability reporting if
available. Otherwise open an issue requesting a private contact channel, without
publishing sensitive details or credentials.

## Releases (maintainers)

Update `manifest.json`, `versions.json`, root and plugin package versions, and
lockfiles together. Rebuild the tracked bundle and verify the full checks.
Tag the tested commit with the exact manifest version, e.g. `1.2.1`, **without
a `v` prefix**. The release workflow validates the tag, tests, builds, attests
the installer assets, and publishes them. Verify the downloaded bundle with:

```sh
gh attestation verify main.js --repo Developits/Obsync
```

Review the community portal's new scan before claiming the release has passed.
Capability disclosures for vault enumeration and explicit token copying are
expected; do not hide those features to improve a scorecard.
