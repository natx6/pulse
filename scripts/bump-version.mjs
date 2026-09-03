#!/usr/bin/env node
// Bump version in all three places that must stay in sync or the release
// workflow fails with "Tag vX != tauri.conf version vY".
// Usage: node scripts/bump-version.mjs 0.4.14
//    or: npm run bump -- 0.4.14
import fs from "fs";

const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error("Usage: node scripts/bump-version.mjs <x.y.z>");
  process.exit(1);
}

for (const [path, update] of [
  ["package.json", (j) => { j.version = ver; return JSON.stringify(j, null, 2) + "\n"; }],
  ["src-tauri/tauri.conf.json", (j) => { j.version = ver; return JSON.stringify(j, null, 2) + "\n"; }],
  ["src-tauri/Cargo.toml", (s) => s.replace(/^version = ".*"/m, `version = "${ver}"`)],
]) {
  const raw = fs.readFileSync(path, "utf8");
  const next = path.endsWith(".json")
    ? update(JSON.parse(raw))
    : update(raw);
  fs.writeFileSync(path, next);
  console.log(`bumped ${path} → ${ver}`);
}
console.log(`Done. Commit and tag v${ver}.`);
