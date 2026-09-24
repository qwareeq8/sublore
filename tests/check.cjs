"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["storage"]);
function checkManifest(base, value) {
  assert.equal(value.name, "Sublore");
  const files = [...(value.background.scripts || [value.background.service_worker]), ...Object.values(value.action.default_icon),
    ...value.content_scripts.flatMap(s => [...s.js, ...s.css]), value.options_ui.page,
    ...Object.values(value.icons || {})];
  for (const file of files) assert.ok(fs.existsSync(path.join(base, file)), `The manifest references ${file}, which is missing.`);
}
checkManifest(root, manifest);
for (const target of ["firefox", "chrome"]) {
  const folder = path.join(root, "dist", target);
  if (!fs.existsSync(folder)) continue;
  const built = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
  checkManifest(folder, built);
  if (target === "chrome") {
    assert.equal(built.background.service_worker, "src/service-worker.js");
    assert.equal(built.browser_specific_settings, undefined);
  }
}
for (const folder of ["src", "options", "tests", "scripts"]) {
  for (const file of fs.readdirSync(path.join(root, folder))) {
    if (!/\.(js|cjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ["--check", path.join(root, folder, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
}
console.log("Manifest references and JavaScript syntax passed.");
