// Validates the community-directory metadata before build and release.
import fs from "node:fs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const manifest = read("manifest.json");
const pluginPackage = read("plugin/package.json");
const rootPackage = read("package.json");
const versions = read("versions.json");

if (/\bobsidian\b/i.test(manifest.description) || manifest.description.length > 250 || !manifest.description.endsWith(".")) {
  throw new Error('Description must omit "Obsidian", end with a period, and be at most 250 characters');
}
if (manifest.id.includes("obsidian")) {
  throw new Error('Plugin ID must not contain "obsidian"');
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Plugin version must use x.y.z semver");
}
if (manifest.version !== pluginPackage.version || manifest.version !== rootPackage.version) {
  throw new Error("Version mismatch between manifest.json, package.json and plugin/package.json");
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error("versions.json must map the current version to minAppVersion");
}
if (!fs.existsSync("README.md") || !fs.existsSync("LICENSE")) {
  throw new Error("README.md and LICENSE must exist in the repository root");
}

console.log(`Manifest OK: ${manifest.id} v${manifest.version} (Obsidian ${manifest.minAppVersion}+)`);
