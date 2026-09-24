"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { deflateRawSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
for (const icon of Object.values(sourceManifest.icons)) {
  if (!fs.existsSync(path.join(root, icon))) throw new Error(`Missing icon: ${icon}`);
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [filename, data] of entries) {
    const name = Buffer.from(filename);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    parts.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10); directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
fs.mkdirSync(output, { recursive: true });
for (const target of ["firefox", "chrome"]) {
  const folder = path.resolve(output, target);
  if (path.dirname(folder) !== output) throw new Error("Invalid build output path.");
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder);
  const manifest = structuredClone(sourceManifest);
  if (target === "chrome") {
    delete manifest.browser_specific_settings;
    manifest.background = { service_worker: "src/service-worker.js" };
    manifest.minimum_chrome_version = "120";
  }
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const name of ["src", "options", "assets"]) fs.cpSync(path.join(root, name), path.join(folder, name), { recursive: true });
  function collect(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
      const filename = path.join(dir, item.name);
      return item.isDirectory() ? collect(filename) : [[path.relative(folder, filename).replaceAll(path.sep, "/"), fs.readFileSync(filename)]];
    });
  }
  const archive = zip(collect(folder));
  const name = `sublore-${target}.zip`;
  fs.writeFileSync(path.join(output, name), archive);
  console.log(`${name}: ${archive.length} bytes; SHA-256 ${createHash("sha256").update(archive).digest("hex")}`);
}

// The userscript bundles the same sources with userscript/shim.js standing in for extension APIs.
function htmlTree(html) {
  const root = [null, {}, []], stack = [root];
  const voids = new Set(["img", "input", "br", "hr", "meta", "link"]);
  for (const [, close, tag, attrs, text] of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    const parent = stack[stack.length - 1];
    if (text !== undefined) {
      if (text.trim()) parent[2].push(text.replace(/\s+/g, " "));
      else if (parent[2].length && typeof parent[2][parent[2].length - 1] !== "string") parent[2].push(" ");
      continue;
    }
    if (close) { stack.pop(); continue; }
    const attributes = {};
    for (const [, name, value] of attrs.matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) attributes[name] = value ?? "";
    const node = [tag.toLowerCase(), attributes, []];
    parent[2].push(node);
    if (!voids.has(node[0])) stack.push(node);
  }
  return root[2];
}
{
  const read = file => fs.readFileSync(path.join(root, file), "utf8");
  const dataUri = file => `data:${file.endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${fs.readFileSync(path.join(root, file)).toString("base64")}`;
  const main = read("options/options.html").match(/<main>[\s\S]*<\/main>/)[0]
    .replace(/src="\.\.\/(assets\/[^"]+)"/g, (_, file) => `src="${dataUri(file)}"`);
  const optionsCss = read("options/options.css").replaceAll(":root", ":host").replace(/^body \{/m, ".sublore-page {") +
    "\n.sublore-page { position: absolute; inset: 0; overflow: auto; }\n.page-header { position: relative; }\n" +
    ".sublore-close { position: absolute; inset-inline-end: 0; top: 0; }\n";
  const header = `// ==UserScript==
// @name         ${sourceManifest.name}
// @namespace    ${sourceManifest.name}
// @version      ${sourceManifest.version}
// @description  ${sourceManifest.description}
// @icon         data:image/png;base64,${fs.readFileSync(path.join(root, "assets/icon-48.png")).toString("base64")}
${sourceManifest.content_scripts[0].matches.map(match => `// @match        ${match}`).join("\n")}
// @connect      arctic-shift.photon-reddit.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_addElement
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;
  const body = [
    read("userscript/shim.js"),
    `const OPTIONS_CSS = ${JSON.stringify(optionsCss)};`,
    `const OPTIONS_TREE = ${JSON.stringify(htmlTree(main))};`,
    `GM_addStyle(${JSON.stringify(read("src/styles.css"))});`,
    ...["settings", "api", "cache", "scheduler", "background", "discovery", "render", "content"].map(name => read(`src/${name}.js`)),
    `function runOptions(document) {\n${read("options/options.js")}\n}`,
  ].join("\n");
  const script = `${header}\n(() => {\n${body}\n})();\n`;
  const name = "sublore.user.js";
  fs.writeFileSync(path.join(output, name), script);
  console.log(`${name}: ${Buffer.byteLength(script)} bytes; SHA-256 ${createHash("sha256").update(script).digest("hex")}`);
}
