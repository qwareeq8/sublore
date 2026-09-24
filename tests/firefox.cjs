"use strict";
// Firefox WebDriver BiDi does not report extension background requests, so the Arctic Shift API is served
// by a local proxy that terminates TLS for its host with a throwaway certificate and refuses every other host.
const puppeteer = require("puppeteer-core");
const browsers = require("@puppeteer/browsers");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const extension = path.resolve(__dirname, "../dist/firefox");
const apiHost = "arctic-shift.photon-reddit.com";
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgpIbQ0AW7+I4dOO8Q
XBrcwpztxY4Sx/byWnRklp1sEJihRANCAATQ7pkzu98tOloqotYl6Q3r3GcfNRlC
53Mw48i2cAW2IgyPo9XYfw2w1BBUsQ3rqqs0KtRsA3Tvyfq9zzp9vZl9
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
MIIB1DCCAXqgAwIBAgIUZhw906q0aOpErnjpMvJgcEZdSXIwCgYIKoZIzj0EAwIw
KTEnMCUGA1UEAwweYXJjdGljLXNoaWZ0LnBob3Rvbi1yZWRkaXQuY29tMCAXDTI2
MDkyNDE2NTU0N1oYDzIxMjYwODMxMTY1NTQ3WjApMScwJQYDVQQDDB5hcmN0aWMt
c2hpZnQucGhvdG9uLXJlZGRpdC5jb20wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AATQ7pkzu98tOloqotYl6Q3r3GcfNRlC53Mw48i2cAW2IgyPo9XYfw2w1BBUsQ3r
qqs0KtRsA3Tvyfq9zzp9vZl9o34wfDAdBgNVHQ4EFgQUvSrCHEpQl3vB+MD7+u80
GSolYhwwHwYDVR0jBBgwFoAUvSrCHEpQl3vB+MD7+u80GSolYhwwDwYDVR0TAQH/
BAUwAwEB/zApBgNVHREEIjAggh5hcmN0aWMtc2hpZnQucGhvdG9uLXJlZGRpdC5j
b20wCgYIKoZIzj0EAwIDSAAwRQIgQMYXuyD4y+Hcgf0QP93xVjf2YnlldH1cXCg3
GufvvnACIQCIjN2AQmIaj4PZr4hDvMRj5kVv/uc+PpyPKQSPhCkwqg==
-----END CERTIFICATE-----`;
const fixture = '<!doctype html><shreddit-comment author="FixtureUser"><div slot="commentMeta"><a href="/user/FixtureUser/">FixtureUser</a></div><div slot="comment">Fixture comment.</div></shreddit-comment>';
async function firefoxBinary() {
  if (process.env.FIREFOX_BINARY) return process.env.FIREFOX_BINARY;
  const cacheDir = path.join(os.homedir(), ".cache", "puppeteer");
  const installed = (await browsers.getInstalledBrowsers({ cacheDir })).find(item => item.browser === "firefox");
  if (installed) return installed.executablePath;
  const platform = browsers.detectBrowserPlatform();
  const buildId = await browsers.resolveBuildId("firefox", platform, "stable");
  return (await browsers.install({ browser: "firefox", buildId, cacheDir })).executablePath;
}
(async () => {
  let apiCalls = 0;
  const api = https.createServer({ key, cert }, (request, response) => {
    apiCalls++;
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify({ data: [{ subreddit: "Fauxmoi", count: 79 }] }));
  });
  const proxy = http.createServer((request, response) => response.writeHead(403).end());
  proxy.on("connect", (request, socket, head) => {
    if (request.url !== `${apiHost}:443`) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    api.emit("connection", socket);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address();
  const { browser_specific_settings: { gecko: { id } } } = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
  const uuid = crypto.randomUUID();
  const browser = await puppeteer.launch({ browser: "firefox", headless: true, acceptInsecureCerts: true, executablePath: await firefoxBinary(),
    // System access lets WebDriver BiDi open and script the privileged moz-extension options page.
    args: ["--remote-allow-system-access"],
    extraPrefsFirefox: { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": port,
      "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": port, "network.proxy.no_proxies_on": "",
      "extensions.webextensions.uuids": JSON.stringify({ [id]: uuid }) } });
  try {
    const bidi = browser.connection;
    const { result: { intercept } } = await bidi.send("network.addIntercept", { phases: ["beforeRequestSent"],
      urlPatterns: [{ type: "pattern", protocol: "https", hostname: "www.reddit.com" }] });
    bidi.on("network.beforeRequestSent", event => {
      if (!event.isBlocked || !event.intercepts?.includes(intercept)) return;
      bidi.send("network.provideResponse", { request: event.request.request, statusCode: 200, reasonPhrase: "OK",
        headers: [{ name: "Content-Type", value: { type: "string", value: "text/html" } }],
        body: { type: "string", value: fixture } }).catch(() => {});
    });
    const errors = [];
    await bidi.send("session.subscribe", { events: ["log.entryAdded"] });
    bidi.on("log.entryAdded", entry => { if (entry.type === "javascript") errors.push(entry.text); });
    assert.equal(await browser.installExtension(extension), id);
    const page = await browser.newPage();
    // Puppeteer over BiDi can miss the end of a navigation, so the page navigates itself and the test polls.
    const load = async (navigate, ready, message) => {
      await page.evaluate(navigate);
      for (const end = Date.now() + 30000; !(await page.evaluate(ready).catch(() => false));) {
        assert.ok(Date.now() < end, message);
        await delay(100);
      }
    };
    await load(() => { setTimeout(() => { location.href = "https://www.reddit.com/r/Fauxmoi/comments/abc123/fixture/"; }, 0); },
      () => location.hostname === "www.reddit.com" && Boolean(document.querySelector(".sublore-badges button")),
      "The fixture thread must show the Check button.");
    assert.equal(await page.$eval(".sublore-badges button", element => element.textContent), "Check");
    await page.click(".sublore-badges button");
    await page.waitForFunction(() => document.querySelector(".sublore-badges button")?.textContent === "Check");
    assert.equal(apiCalls, 0, "Lookups must wait for consent.");
    // Puppeteer receives no navigation events from privileged pages, and BiDi input actions refuse them,
    // so the options tab is driven with raw BiDi commands and DOM events.
    const { result: { context } } = await bidi.send("browsingContext.create", { type: "tab" });
    await bidi.send("browsingContext.navigate", { context, url: `moz-extension://${uuid}/options/options.html`, wait: "complete" });
    const inOptions = async (fn, ...args) => {
      const { result } = await bidi.send("script.callFunction", { target: { context }, awaitPromise: true,
        functionDeclaration: `async () => (${fn})(...${JSON.stringify(args)})` });
      if (result.type === "exception") throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async fn => {
      for (const end = Date.now() + 10000; !(await inOptions(fn));) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${fn}.`);
        await delay(100);
      }
    };
    await until(() => !document.getElementById("controls").disabled);
    assert.equal(await inOptions(() => document.getElementById("consent").hidden), false);
    await inOptions(() => document.getElementById("allow").click());
    await until(() => document.getElementById("consent").hidden);
    await page.click(".sublore-badges button");
    await page.waitForSelector(".sublore-badges a");
    assert.equal(await page.$eval(".sublore-badges a", element => element.textContent), "r/Fauxmoi · 79");
    assert.equal(apiCalls, 1);
    await load(() => { window.beforeReload = true; setTimeout(() => location.reload(), 0); },
      () => !window.beforeReload && Boolean(document.querySelector(".sublore-badges a")),
      "The reloaded page must show the cached badge.");
    assert.equal(apiCalls, 1);
    await inOptions(value => {
      const input = document.getElementById("minCount");
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('button[type="submit"]').click();
    }, "2");
    await until(() => document.getElementById("status").textContent === "Settings saved.");
    assert.equal(await inOptions(async () => (await browser.storage.local.get("settings")).settings.minCount), 2);
    await inOptions(() => document.getElementById("clear").click());
    await page.waitForFunction(() => document.querySelector(".sublore-badges button")?.textContent === "Check" && !document.querySelector(".sublore-badges a"));
    assert.equal(apiCalls, 1);
    assert.deepEqual(errors, []);
    console.log("Packaged Firefox extension passed: temporary add-on install, background scripts, real extension messaging, content injection, consent, lookup, cache hit, options save, and cache clear. A local proxy served the API, so no public API calls were made.");
  } finally {
    await browser.close();
    api.closeAllConnections();
    proxy.close();
    api.close();
  }
// Exit explicitly, because the local proxy keeps Node running when a launch step fails.
})().catch(error => { console.error(error); process.exit(1); });
