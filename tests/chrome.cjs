"use strict";
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const extension = path.resolve(__dirname, "../dist/chrome");
(async () => {
  const context = await chromium.launchPersistentContext("", { headless: true,
    ...(process.env.CHROMIUM_BINARY ? { executablePath: process.env.CHROMIUM_BINARY } : { channel: "chromium" }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const errors = [];
    context.on("weberror", error => errors.push(error.error().message));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    await worker.evaluate(() => {
      globalThis.testApiCalls = 0;
      globalThis.fetch = async () => {
        globalThis.testApiCalls++;
        return new Response(JSON.stringify({ data: [{ subreddit: "Fauxmoi", count: 79 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    const page = await context.newPage();
    await page.route("https://www.reddit.com/**", route => route.fulfill({ contentType: "text/html", body:
      '<!doctype html><shreddit-comment author="FixtureUser"><div slot="commentMeta"><a href="/user/FixtureUser/">FixtureUser</a></div><div slot="comment">Fixture comment.</div></shreddit-comment>' }));
    await page.goto("https://www.reddit.com/r/Fauxmoi/comments/abc123/fixture/");
    await page.waitForSelector(".sublore-badges button");
    const settingsPages = () => context.pages().filter(item => item.url() === `chrome-extension://${id}/options/options.html`);
    // Installing opens settings; close it so the click below must open it again.
    for (const end = Date.now() + 10000; !settingsPages().length;) {
      assert.ok(Date.now() < end, "Installing must open settings.");
      await page.waitForTimeout(100);
    }
    for (const item of settingsPages()) await item.close();
    await page.locator(".sublore-badges button").click();
    for (const end = Date.now() + 10000; !settingsPages().length;) {
      assert.ok(Date.now() < end, "Check without consent must open settings.");
      await page.waitForTimeout(100);
    }
    const consent = settingsPages().at(-1);
    await consent.waitForFunction(() => !document.getElementById("consent").hidden);
    await consent.locator("#allow").click();
    await consent.waitForFunction(() => document.getElementById("consent").hidden);
    assert.equal(await worker.evaluate(() => testApiCalls), 0);
    await page.locator(".sublore-badges button").click();
    await page.waitForSelector(".sublore-badges a");
    assert.equal(await page.locator(".sublore-badges a").textContent(), "r/Fauxmoi · 79");
    assert.equal(await worker.evaluate(() => testApiCalls), 1);
    await page.reload();
    await page.waitForSelector(".sublore-badges a");
    assert.equal(await worker.evaluate(() => testApiCalls), 1);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options/options.html`);
    await options.waitForFunction(() => !document.getElementById("controls").disabled);
    assert.equal(await options.title(), "Sublore settings");
    await options.locator("#minCount").fill("2");
    await options.locator('button[type="submit"]').click();
    await options.waitForFunction(() => document.getElementById("status").textContent.startsWith("Settings saved"));
    assert.equal(await worker.evaluate(async () => (await browser.storage.local.get("settings")).settings.minCount), 2);
    await options.locator("#clear").click();
    await page.waitForSelector(".sublore-badges button");
    if (process.argv.includes("--lifecycle")) {
      await options.locator("#intervalSeconds").fill("35");
      await options.locator('button[type="submit"]').click();
      await options.waitForFunction(() => document.getElementById("status").textContent.startsWith("Settings saved"));
      await page.locator(".sublore-badges button").click();
      await page.waitForSelector(".sublore-badges a");
      await page.evaluate(() => document.body.insertAdjacentHTML("beforeend",
        '<shreddit-comment author="SecondUser"><div slot="commentMeta"><a href="/user/SecondUser/">SecondUser</a></div></shreddit-comment>'));
      await page.locator('[author="SecondUser"] .sublore-badges button').click();
      await page.waitForSelector('[author="SecondUser"] .sublore-badges a', { timeout: 45000 });
      assert.equal(await worker.evaluate(() => testApiCalls), 3);
      console.log("Chrome worker remained alive through a 35-second queued lookup.");
    }
    assert.deepEqual(errors, []);
    console.log("Packaged Chrome extension passed: service worker, real extension messaging, content injection, consent, lookup, cache hit, options save, and cache clear. API responses mocked; no public API calls.");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
