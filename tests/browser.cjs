"use strict";
const playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.BROWSER_ENGINE || "firefox";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = file => fs.readFileSync(path.join(root, file), "utf8");
const screenshotDir = process.env.SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "sublore-ui-"));

function mockBrowser() {
  const listeners = [];
  window.mock = { requests: [], fresh: [], cache: {}, responses: {}, listeners, saved: null, clears: 0, consent: false };
  const entry = activity => ({ activity, schema: 1, lookbackMonths: 6, fetchedAt: Date.now(), after: "2026-03-01T00:00:00.000Z" });
  mock.cache.cacheduser = entry([{ subreddit: "fauxmoi", count: 27 }]);
  mock.responses.alice = { ok: true, entry: entry([
    { subreddit: "fauxmoi", count: 27 }, { subreddit: "VaushV", count: 12 },
    { subreddit: "DGGsnark", count: 9 }, { subreddit: "socialism", count: 4 },
    { subreddit: "Destiny", count: 100 },
    { subreddit: "Hasan_Piker", count: 1 }, { subreddit: "test", count: 200 },
    { subreddit: "Unwatched", count: 500 },
  ]) };
  mock.responses.bob = { ok: true, entry: entry([{ subreddit: "Test", count: 79 }]) };
  mock.responses.newbie = { ok: true, entry: { ...entry([{ subreddit: "test", count: 2 }]), recent: { after: "2026-09-17T00:00:00.000Z", activity: [{ subreddit: "test", count: 2 }] } } };
  window.browser = {
    storage: { onChanged: { addListener: listener => listeners.push(listener) } },
    runtime: {
      async sendMessage(message) {
        if (message.type === "settings") return { ok: true, settings: Sublore.settings({ watchlist: [...Sublore.defaults.watchlist, "test"] }), consent: mock.consent };
        if (message.type === "allow") { mock.consent = true; return { ok: true }; }
        if (message.type === "cached") return { ok: true, entry: mock.cache[message.author] || null };
        if (message.type === "save-settings") { mock.saved = message.settings; return { ok: true }; }
        if (message.type === "clear-cache") { mock.cache = {}; mock.clears++; return { ok: true }; }
      },
      connect() {
        let callback;
        return {
          onMessage: { addListener: listener => { callback = listener; } },
          onDisconnect: { addListener: () => {} },
          disconnect() {},
          postMessage({ author, fresh }) {
            mock.requests.push(author);
            if (fresh) mock.fresh.push(author);
            setTimeout(() => callback(mock.responses[author] || { ok: true, entry: entry([]) }), 30);
          },
        };
      },
    },
  };
}

const modern = (author, nested = "") => `<shreddit-comment author="${author}" thingid="t1_${author}">
  <div slot="commentMeta"><span class="author-hovercard-trigger"><faceplate-hovercard><a href="/user/${author}/">${author}</a></faceplate-hovercard></span> <span>2d ago</span></div>
  <div slot="comment">Comment text with <a href="/user/BodyMention/">u/BodyMention</a>.</div>${nested}</shreddit-comment>`;
const old = author => `<div class="thing comment" data-author="${author}"><p class="tagline"><a class="author" href="https://old.reddit.com/user/${author}">${author}</a></p><div class="md">Body <a href="/u/Mention/">Mention</a></div></div>`;
const fixture = `<!doctype html><html><head><style>
  body {font: 14px system-ui; background:#fff; color:#20242a; margin:24px}
  a {color:inherit} shreddit-comment,.thing.comment {display:block; padding:12px; border-left:1px solid #8793a0; margin:8px}
  body.dark {background:#15191f;color:#e7ebf0}
  [slot="comment"] {margin-top:8px} [slot="commentMeta"] {display:flex; flex-wrap:wrap;align-items:center;gap:4px}
  </style></head><body><h1>Thread fixture</h1><a href="/user/Navigation/">Navigation</a>
  ${modern("Alice", modern("Bob"))}${modern("Alice")}${modern("CachedUser")}${old("OldUser")}
  ${modern("[deleted]")}${modern("NoMatch")}${modern("Newbie")}${modern("Suspended")}${modern("RateLimited")}
  <div id="dynamic"></div></body></html>`;

(async () => {
  const binary = engine === "firefox" ? process.env.FIREFOX_BINARY : process.env.CHROMIUM_BINARY;
  const browser = await playwright[engine].launch({ headless: true, ...(binary ? { executablePath: binary } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.goto("https://www.reddit.com/r/test/comments/abc123/thread/");
    await page.addScriptTag({ content: source("src/settings.js") });
    await page.evaluate(mockBrowser);
    await page.addStyleTag({ content: source("src/styles.css") });
    for (const file of ["discovery", "render", "content"]) await page.addScriptTag({ content: source(`src/${file}.js`) });
    await page.waitForFunction(() => document.querySelectorAll(".sublore-badges").length === 9);
    await page.waitForFunction(() => document.querySelector('.sublore-badges a[data-subreddit="fauxmoi"]'));
    assert.equal(await page.evaluate(() => mock.requests.length), 0, "Initial render must not query the API.");
    assert.equal(await page.locator("faceplate-hovercard .sublore-badges, .author-hovercard-trigger .sublore-badges").count(), 0, "Badges must sit outside Reddit's hover card.");
    assert.equal(await page.locator('[author="[deleted]"] .sublore-badges').count(), 0);
    assert.equal(await page.locator('a[href="/user/BodyMention/"] + .sublore-badges').count(), 0);
    await page.locator('[author="Alice"] > [slot="commentMeta"] button').first().focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll('[author="Alice"] .sublore-badges a').length === 6);
    assert.deepEqual(await page.evaluate(() => mock.requests), ["alice"]);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.subreddit), "test");
    assert.equal(await page.locator('[author="Alice"] .sublore-badges a[data-subreddit="test"]').first().getAttribute("href"),
      "https://arctic-shift.photon-reddit.com/search?fun=comments_search&subreddit=test&author=alice&limit=25&sort=desc&after=2026-03-01");
    assert.equal(await page.locator('.sublore-badges a[data-subreddit="test"]').count(), 2);
    assert.equal(await page.locator('.sublore-badges a[data-subreddit="Hasan_Piker"]').count(), 0);
    await page.locator('[author="Bob"] > [slot="commentMeta"] button').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[author="Bob"] .sublore-badges a'));
    assert.equal(await page.locator('[author="Bob"] .sublore-badges a').textContent(), "r/Test · 79");
    assert.deepEqual(await page.evaluate(() => mock.requests), ["alice", "bob"]);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.subreddit), "Test");
    const expand = page.locator('[author="Alice"] > [slot="commentMeta"] button[aria-expanded]').first();
    await expand.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator('[author="Alice"] > [slot="commentMeta"]').first().locator('.sublore-badges a').count(), 6);
    assert.equal(await page.locator('.sublore-badges a[data-subreddit="Hasan_Piker"]').textContent(), "r/Hasan_Piker · 1");
    assert.equal(await page.locator('.sublore-badges a[data-subreddit="Unwatched"]').count(), 0);
    const beforeRecheck = await page.evaluate(() => mock.requests.length);
    await page.locator('[author="CachedUser"] .sublore-recheck').click();
    await page.waitForFunction(count => mock.requests.length === count + 1, beforeRecheck);
    assert.deepEqual(await page.evaluate(() => mock.fresh), ["cacheduser"]);
    assert.equal(await page.locator('.sublore-badges a[data-subreddit="Destiny"]').count(), 0);
    assert.equal(await page.locator('[author="Alice"] > [slot="commentMeta"]').first().locator('button[aria-expanded]').getAttribute("aria-expanded"), "true");
    await page.evaluate(html => document.getElementById("dynamic").insertAdjacentHTML("beforeend", html), modern("Dynamic"));
    await page.waitForFunction(() => document.querySelector('[author="Dynamic"] .sublore-badges'));
    await page.evaluate(() => { for (let i = 0; i < 15; i++) document.getElementById("dynamic").append(document.createElement("i")); });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('[author="Dynamic"] .sublore-badges').count(), 1);
    await page.locator('[author="Newbie"] button').click();
    await page.waitForSelector('[author="Newbie"] .sublore-new svg');
    assert.ok((await page.locator('[author="Newbie"] .sublore-new').getAttribute("aria-label")).startsWith("New to r/test"));
    assert.equal(await page.locator('[author="Newbie"] .sublore-new').getAttribute("href"),
      "https://arctic-shift.photon-reddit.com/search?fun=comments_search&subreddit=test&author=newbie&limit=25&sort=desc&after=2026-09-17");
    assert.equal(await page.locator('[author="Alice"] .sublore-new').count(), 0);
    await page.locator('[author="NoMatch"] button').click();
    await page.waitForFunction(() => document.querySelector('[author="NoMatch"] .sublore-empty'));
    assert.equal(await page.locator('[author="NoMatch"] .sublore-empty').textContent(), "No archive data");
    await page.evaluate(() => {
      mock.responses.suspended = { ok: false, error: "Arctic Shift request failed (HTTP 404)." };
      mock.responses.ratelimited = { ok: false, error: "Arctic Shift is rate limited.", retryAt: Date.now() + 300 };
    });
    await page.locator('[author="Suspended"] button').click();
    await page.waitForFunction(() => document.querySelector('[author="Suspended"] button').textContent === "Retry");
    await page.locator('[author="RateLimited"] button').click();
    await page.waitForFunction(() => document.querySelector('[author="RateLimited"] button').textContent.startsWith("Retry at "));
    await page.waitForFunction(() => document.querySelector('[author="RateLimited"] button').textContent === "Retry");
    await page.evaluate(() => { delete mock.responses.ratelimited; });
    await page.locator('[author="RateLimited"] button').click();
    await page.waitForFunction(() => document.querySelector('[author="RateLimited"] .sublore-empty'));
    await page.screenshot({ path: path.join(screenshotDir, "thread-light.png"), fullPage: true });
    await page.evaluate(() => document.body.classList.add("dark"));
    await page.screenshot({ path: path.join(screenshotDir, "thread-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 320), true);
    await page.evaluate(() => {
      const item = document.querySelector('[author="Dynamic"]');
      item.setAttribute("author", "Replacement");
      item.querySelector("a").href = "/u/Replacement/";
      item.querySelector("a").textContent = "Replacement";
    });
    await page.waitForFunction(() => document.querySelector('[author="Replacement"] button')?.title.includes("u/replacement"));
    await page.evaluate(() => { history.pushState({}, "", "/r/test/"); document.body.append(document.createElement("i")); });
    await page.waitForFunction(() => document.querySelectorAll(".sublore-badges").length === 0);
    await page.evaluate(() => { history.pushState({}, "", "/r/test/comments/def456/next/"); document.body.append(document.createElement("i")); });
    await page.waitForFunction(() => document.querySelectorAll(".sublore-badges").length === 10);
    await page.evaluate(() => mock.listeners.forEach(listener => listener({ cacheClearedAt: { newValue: Date.now() } }, "local")));
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".sublore-badges").count(), 10);
    const callsBeforeStress = await page.evaluate(() => mock.requests.length);
    const stressStarted = Date.now();
    await page.evaluate(html => document.getElementById("dynamic").insertAdjacentHTML("beforeend", html),
      Array.from({ length: 1000 }, (_, i) => modern(`StressUser${i % 40}`)).join(""));
    await page.waitForFunction(() => document.querySelectorAll(".sublore-badges").length === 1010);
    assert.equal(await page.evaluate(() => mock.requests.length), callsBeforeStress);
    console.log(`Decorated 1,000 inserted comments in ${Date.now() - stressStarted} ms without API calls.`);
    assert.deepEqual(errors, []);

    const options = await browser.newPage({ viewport: { width: 768, height: 1000 } });
    options.on("pageerror", error => errors.push(error.message));
    await options.route("**/*", route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = pathname.replace(/^\//, "");
      const types = { svg: "image/svg+xml", png: "image/png", css: "text/css", js: "text/javascript" };
      return route.fulfill({ contentType: types[file.split(".").pop()] || "text/html", body: fs.readFileSync(path.join(root, file)) });
    });
    await options.addInitScript(mockBrowser);
    await options.goto("https://fixture.invalid/options/options.html");
    await options.waitForFunction(() => !document.getElementById("controls").disabled);
    await options.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    await options.locator("#allow").click();
    await options.waitForFunction(() => mock.consent && document.getElementById("consent").hidden);
    await options.locator("#subreddit").fill("/r/vaushv");
    await options.locator("#add").click();
    assert.match(await options.locator("#subreddit-error").textContent(), /Already/);
    await options.locator("#subreddit").fill("/r/Firefox");
    await options.locator("#subreddit").press("Enter");
    await options.locator("#lookbackMonths").fill("3");
    await options.locator('button[type="submit"]').click();
    await options.waitForFunction(() => mock.saved?.lookbackMonths === 3);
    assert.ok(await options.evaluate(() => mock.saved.watchlist.includes("Firefox")));
    await options.locator("#clear").click();
    await options.waitForFunction(() => mock.clears === 1);
    await options.locator("#restore").click();
    assert.equal(await options.locator("#watchlist li").count(), await options.evaluate(() => Sublore.defaults.watchlist.length));
    await options.locator('button[type="submit"]').click();
    await options.waitForFunction(() => mock.saved.watchlist.includes("DGGsnark") && !mock.saved.watchlist.includes("Destiny"));
    for (const theme of ["light", "dark"]) {
      await options.emulateMedia({ colorScheme: theme });
      await options.screenshot({ path: path.join(screenshotDir, `options-${theme}.png`), fullPage: true });
      for (const width of [320, 768, 1280]) {
        await options.setViewportSize({ width, height: 1000 });
        assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} options overflow at ${width}px`);
      }
    }
    assert.deepEqual(errors, []);
    console.log(`${engine} fixture checks passed: nested/old/dynamic comments, cached-only startup, filtering, expansion, keyboard, errors, retry, SPA, settings, and responsive themes.`);
    console.log(`Screenshots: ${screenshotDir}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
