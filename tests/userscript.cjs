"use strict";
// Runs the built userscript against stubbed userscript-manager grants and mocked API responses.
const playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.BROWSER_ENGINE || "chromium";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const script = fs.readFileSync(path.resolve(__dirname, "../dist/sublore.user.js"), "utf8");
const screenshotDir = process.env.SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "sublore-userscript-"));

function grants() {
  // Session storage stands in for the manager's persistent store so reloads keep values.
  const load = () => JSON.parse(sessionStorage.getItem("gm") || "{}");
  const save = values => sessionStorage.setItem("gm", JSON.stringify(values));
  window.gm = { requests: [], menu: {} };
  window.GM_getValue = (key, fallback) => { const values = load(); return key in values ? values[key] : fallback; };
  window.GM_setValue = (key, value) => { const values = load(); values[key] = value; save(values); };
  window.GM_deleteValue = key => { const values = load(); delete values[key]; save(values); };
  window.GM_listValues = () => Object.keys(load());
  window.GM_addValueChangeListener = () => 0;
  window.GM_registerMenuCommand = (name, callback) => { gm.menu[name] = callback; };
  window.GM_addStyle = css => { const style = document.createElement("style"); style.textContent = css; document.head.append(style); return style; };
  window.GM_xmlhttpRequest = details => {
    gm.requests.push(details.url);
    const timer = setTimeout(() => details.onload({ status: 200, responseHeaders: "content-type: application/json\r\n",
      responseText: JSON.stringify({ data: [{ subreddit: "fauxmoi", count: 27 }, { subreddit: "VaushV", count: 12 }, { subreddit: "Unwatched", count: 90 }] }) }), 30);
    return { abort() { clearTimeout(timer); details.onabort?.(); } };
  };
}

const fixture = `<!doctype html><html><head></head><body style="font:14px system-ui;margin:24px">
  <shreddit-comment author="Alice"><div slot="commentMeta"><span class="author-hovercard-trigger"><faceplate-hovercard><a href="/user/Alice/">Alice</a></faceplate-hovercard></span> <span>2d ago</span></div>
  <div slot="comment">Comment body.</div></shreddit-comment></body></html>`;

(async () => {
  const binary = engine === "firefox" ? process.env.FIREFOX_BINARY : process.env.CHROMIUM_BINARY;
  const browser = await playwright[engine].launch({ headless: true, ...(binary ? { executablePath: binary } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.addInitScript(grants);
    await page.goto("https://www.reddit.com/r/test/comments/abc123/thread/");
    await page.addScriptTag({ content: script });
    const check = page.locator(".sublore-badges button");
    await check.waitFor();
    assert.equal(await check.textContent(), "Check");
    assert.equal(await page.evaluate(() => gm.requests.length), 0, "Rendering must not query the API.");
    assert.equal(await page.locator(".author-hovercard-trigger .sublore-badges").count(), 0);
    await check.click();
    const consent = page.locator("#sublore-options-host #allow");
    await consent.click();
    await page.waitForFunction(() => document.getElementById("sublore-options-host").shadowRoot.getElementById("consent").hidden);
    assert.equal(await page.evaluate(() => gm.requests.length), 0, "Lookups must wait for consent.");
    await page.keyboard.press("Escape");
    await check.click();
    await page.waitForSelector(".sublore-badges a");
    assert.deepEqual(await page.locator(".sublore-badges a").allTextContents(), ["r/fauxmoi · 27", "r/VaushV · 12"]);
    const url = new URL(await page.evaluate(() => gm.requests[0]));
    assert.equal(url.searchParams.get("author"), "alice");

    await page.reload();
    await page.addScriptTag({ content: script });
    await page.waitForSelector(".sublore-badges a");
    assert.equal(await page.evaluate(() => gm.requests.length), 0, "A cached lookup must render without a request.");

    await page.evaluate(() => gm.menu.Settings());
    const panel = page.locator("#sublore-options-host");
    await page.waitForFunction(() => !document.getElementById("sublore-options-host")?.shadowRoot.getElementById("controls").disabled);
    assert.equal(await panel.locator("#watchlist li").count(), await page.evaluate(() => Sublore.defaults.watchlist.length));
    await panel.locator("#minCount").fill("20");
    await panel.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById("sublore-options-host").shadowRoot.getElementById("status").textContent === "Settings saved.");
    assert.equal(await page.evaluate(() => GM_getValue("settings").minCount), 20);
    await page.waitForFunction(() => document.querySelector(".sublore-badges a")?.textContent === "r/fauxmoi · 27" && document.querySelectorAll(".sublore-badges a").length === 1);
    await page.evaluate(() => document.getElementById("sublore-options-host").shadowRoot.querySelector(".sublore-page").scrollTo(0, 0));
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ path: path.join(screenshotDir, `userscript-settings-${theme}.png`) });
    }
    await page.keyboard.press("Escape");
    assert.equal(await panel.count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${engine} userscript checks passed. Screenshots: ${screenshotDir}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
