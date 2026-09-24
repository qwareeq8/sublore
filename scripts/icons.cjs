"use strict";
// Renders the PNG icons from their SVG sources. The 16 and 32 px toolbar icons use full-bleed variants.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const path = require("node:path");
const assets = path.resolve(__dirname, "../assets");
const icons = [["icon-16.svg", 16], ["icon-32.svg", 32], ["icon.svg", 48], ["icon.svg", 128]];
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const [source, size] of icons) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html, body { margin: 0; background: transparent; } svg { display: block; width: ${size}px; height: ${size}px; }</style>${fs.readFileSync(path.join(assets, source), "utf8")}`);
      await page.screenshot({ path: path.join(assets, `icon-${size}.png`), omitBackground: true });
      console.log(`assets/icon-${size}.png`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
