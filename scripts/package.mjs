// Release packaging script for Obsidian Distributed Sync plugin.
// Pure Node standard library; works with GNU/Linux, macOS and Windows.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeZip } from "./zip.mjs";

const rootDir = process.cwd();
const pluginDir = path.join(rootDir, "plugin");
const distDir = path.join(rootDir, "dist");
const manifestPath = path.join(rootDir, "manifest.json");

if (!fs.existsSync(manifestPath)) {
  console.error("Missing manifest.json in the repository root");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = manifest.version;
const pluginId = manifest.id;

// 1. Build latest plugin bundle
console.log("Building plugin bundle...");
execFileSync(process.execPath, ["esbuild.config.mjs"], { cwd: pluginDir, stdio: "inherit" });

// 2. Prepare clean dist directory
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

// 3. Stage plugin directory for folder-based archive
const stageDir = path.join(distDir, pluginId);
fs.mkdirSync(stageDir, { recursive: true });
fs.copyFileSync(path.join(pluginDir, "main.js"), path.join(stageDir, "main.js"));
fs.copyFileSync(manifestPath, path.join(stageDir, "manifest.json"));

// Also copy loose assets for Obsidian/BRAT release requirements
fs.copyFileSync(path.join(pluginDir, "main.js"), path.join(distDir, "main.js"));
fs.copyFileSync(manifestPath, path.join(distDir, "manifest.json"));

// 4. Create deterministic ZIPs without platform-specific tar behavior.
// Standard zip with folder (extract directly into .obsidian/plugins/)
const versionedZip = `${pluginId}-v${version}.zip`;
const genericZip = `${pluginId}.zip`;
const versionedZipPath = path.join(distDir, versionedZip);
const genericZipPath = path.join(distDir, genericZip);

// Flat zip without parent folder (extract directly into .obsidian/plugins/distributed-sync/)
const flatZip = `${pluginId}-flat.zip`;
const flatZipPath = path.join(distDir, flatZip);

console.log(`Packaging ${versionedZip}...`);
fs.writeFileSync(versionedZipPath, makeZip(["main.js", "manifest.json"].map((file) =>
  [`${pluginId}/${file}`, fs.readFileSync(path.join(stageDir, file))])));
fs.copyFileSync(versionedZipPath, genericZipPath);

console.log(`Packaging ${flatZip}...`);
fs.writeFileSync(flatZipPath, makeZip(["main.js", "manifest.json"].map((file) =>
  [file, fs.readFileSync(path.join(stageDir, file))])));

console.log(`\nSuccessfully created release assets in dist/:`);
console.log(`  - ${versionedZip} (${(fs.statSync(versionedZipPath).size / 1024).toFixed(1)} KB) [with folder]`);
console.log(`  - ${genericZip} (${(fs.statSync(genericZipPath).size / 1024).toFixed(1)} KB) [with folder]`);
console.log(`  - ${flatZip} (${(fs.statSync(flatZipPath).size / 1024).toFixed(1)} KB) [root files]`);
console.log(`  - main.js`);
console.log(`  - manifest.json`);
