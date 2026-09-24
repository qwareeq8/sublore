"use strict";
// Drives Firefox for Android through geckodriver's WebDriver HTTP API. The device reaches a local proxy through
// adb reverse; the proxy serves the Reddit fixture and the Arctic Shift API with a throwaway certificate and
// refuses every other host.
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const dist = path.resolve(__dirname, "../dist");
const hosts = { "arctic-shift.photon-reddit.com": "api", "www.reddit.com": "reddit" };
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguxXzcTZQ8nq6fmIQ
PVEBaSO0dNlF/eQ/tGC+lUNhmqahRANCAASi6YCRXIlKNDkcsGVXjfQCcpmnsRcU
nr0jF0weBudnJ9A3Yife9tKLPsXpZ6G0WbA/scE53ZqzedeTm4TL2DKP
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
MIIBwTCCAWigAwIBAgIURnTmTlKnmfvGrr4LEUxsnPzW31AwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMU3VibG9yZSB0ZXN0MCAXDTI2MDkyNDE5MzU0M1oYDzIxMjYw
ODMxMTkzNTQzWjAXMRUwEwYDVQQDDAxTdWJsb3JlIHRlc3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAASi6YCRXIlKNDkcsGVXjfQCcpmnsRcUnr0jF0weBudnJ9A3
Yife9tKLPsXpZ6G0WbA/scE53ZqzedeTm4TL2DKPo4GPMIGMMB0GA1UdDgQWBBSX
uuY2Yzda7xQ5zEYPv2k2FWfiCDAfBgNVHSMEGDAWgBSXuuY2Yzda7xQ5zEYPv2k2
FWfiCDAPBgNVHRMBAf8EBTADAQH/MDkGA1UdEQQyMDCCDnd3dy5yZWRkaXQuY29t
gh5hcmN0aWMtc2hpZnQucGhvdG9uLXJlZGRpdC5jb20wCgYIKoZIzj0EAwIDRwAw
RAIgUKOtEz+tyBnCI22m19fIPet6/YK+cBpURlixV3KVNc4CIGgA7uxqfOKVtPTc
QeOzCiTWKfAq15qZv62DBiRtqerc
-----END CERTIFICATE-----`;
// The fixture thread from tests/firefox.cjs, with a viewport so the phone renders it at device width.
const fixture = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><shreddit-comment author="FixtureUser"><div slot="commentMeta"><a href="/user/FixtureUser/">FixtureUser</a></div><div slot="comment">Fixture comment.</div></shreddit-comment>';
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
(async () => {
  const serial = process.env.ANDROID_SERIAL || execFileSync("adb", ["devices"], { encoding: "utf8" }).split("\n").slice(1)
    .map(line => line.trim().split("\t")).find(([, state]) => state === "device")?.[0];
  assert.ok(serial, "Connect an adb device or start an emulator with Firefox for Android 152 or later.");
  const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], { maxBuffer: 64 << 20 });
  const { browser_specific_settings: { gecko: { id } } } = JSON.parse(fs.readFileSync(path.join(dist, "firefox/manifest.json"), "utf8"));
  const uuid = crypto.randomUUID();
  let apiCalls = 0;
  const server = https.createServer({ key, cert }, (request, response) => {
    if (hosts[request.headers.host] === "api") {
      apiCalls++;
      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return response.end(JSON.stringify({ data: [{ subreddit: "Fauxmoi", count: 79 }] }));
    }
    response.writeHead(200, { "Content-Type": "text/html" }).end(fixture);
  });
  const proxy = http.createServer((request, response) => response.writeHead(403).end());
  proxy.on("connect", (request, socket, head) => {
    const [host, port] = request.url.split(":");
    if (!hosts[host] || port !== "443") return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    server.emit("connection", socket);
  });
  const proxyPort = await listen(proxy);
  // System access lets Marionette script the privileged moz-extension settings page.
  const driver = spawn(process.env.GECKODRIVER || "geckodriver", ["--port", "0", "--allow-system-access"],
    { stdio: ["ignore", "pipe", "inherit"] });
  driver.on("error", () => {});
  let log = "";
  driver.stdout.on("data", chunk => { log += chunk; if (process.env.GECKODRIVER_LOG) process.stderr.write(chunk); });
  let sessionId, driverPort, devicePort;
  const unmap = () => { try { if (devicePort) adb("reverse", "--remove", `tcp:${devicePort}`); } catch { /* The device may have disconnected. */ } };
  // An interrupted run still stops geckodriver and removes its port mapping.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { driver.kill(); unmap(); process.exit(130); });
  async function command(method, route, body) {
    const response = await fetch(`http://127.0.0.1:${driverPort}${route}`, { method,
      headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    const { value } = await response.json();
    if (!response.ok) throw new Error(`${route}: ${value.error}: ${value.message}`);
    return value;
  }
  const session = (method, route, body) => command(method, `/session/${sessionId}${route}`, body);
  const run = (fn, ...args) => session("POST", "/execute/sync", { script: `return (${fn})(...arguments);`, args });
  const until = async (fn, ...args) => {
    let failure = "";
    for (const end = Date.now() + 20000; !(await run(fn, ...args).catch(error => { failure = ` ${error.message}`; }));) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${fn}.${failure}`);
      await delay(200);
    }
  };
  // Screenshots capture the whole phone screen, so they show the tab Firefox has in front.
  const screenshot = async name => {
    if (!process.env.SCREENSHOT_DIR) return;
    // A new tab can report a loaded document before the phone has painted it.
    await run(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await delay(1500);
    fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, name), adb("exec-out", "screencap", "-p"));
  };
  try {
    // Port 0 lets adb choose a port that is free on the device.
    devicePort = Number(execFileSync("adb", ["-s", serial, "reverse", "tcp:0", `tcp:${proxyPort}`], { encoding: "utf8" }).trim());
    for (const end = Date.now() + 10000; !(driverPort = log.match(/Listening on [\d.]+:(\d+)/)?.[1]);) {
      assert.ok(Date.now() < end && driver.pid && driver.exitCode === null, "Install geckodriver or set GECKODRIVER to its path.");
      await delay(100);
    }
    ({ sessionId } = await command("POST", "/session", { capabilities: { alwaysMatch: { acceptInsecureCerts: true,
      // geckodriver clears the app data, and these Fenix launch extras skip the first-run onboarding it brings back.
      "moz:firefoxOptions": { androidPackage: "org.mozilla.firefox", androidDeviceSerial: serial, androidIntentArguments: ["-a",
        "android.intent.action.VIEW", "-d", "about:blank", "--ez", "automationtest", "true", "--ez", "performancetest", "true"],
        prefs: { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": devicePort,
          "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": devicePort, "network.proxy.no_proxies_on": "",
          "layout.css.prefers-color-scheme.content-override": 1,
          "extensions.webextensions.uuids": JSON.stringify({ [id]: uuid }) } } } } }));
    const optionsUrl = `moz-extension://${uuid}/options/options.html`;
    const thread = await session("GET", "/window");
    const tabs = () => session("GET", "/window/handles");
    const newTab = async known => {
      for (const end = Date.now() + 20000; ;) {
        const handle = (await tabs()).find(item => !known.includes(item));
        if (handle) return handle;
        assert.ok(Date.now() < end, "Settings must open in a new tab.");
        await delay(200);
      }
    };
    // A tab opened by the extension loads twice, so the window is selected again before each check.
    const openSettings = async handle => {
      for (const end = Date.now() + 20000; ;) {
        await session("POST", "/window", { handle });
        const ready = await run(url => location.href === url && !document.getElementById("controls").disabled, optionsUrl)
          .catch(() => false);
        if (ready) return;
        assert.ok(Date.now() < end, "Settings must finish loading.");
        await delay(200);
      }
    };
    const closeSettings = async () => {
      await session("DELETE", "/window");
      await session("POST", "/window", { handle: thread });
    };
    const click = async selector => {
      const element = await session("POST", "/element", { using: "css selector", value: selector });
      await session("POST", `/element/${Object.values(element)[0]}/click`, {});
    };
    // Installing opens settings; close it so the click below must open it again.
    let known = await tabs();
    assert.equal(await session("POST", "/moz/addon/install",
      { addon: fs.readFileSync(path.join(dist, "sublore-firefox.zip")).toString("base64"), temporary: true }), id);
    await openSettings(await newTab(known));
    await closeSettings();
    await session("POST", "/url", { url: "https://www.reddit.com/r/Fauxmoi/comments/abc123/fixture/" });
    await until(() => document.querySelector(".sublore-badges button")?.textContent === "Check");
    known = await tabs();
    await click(".sublore-badges button");
    const settings = await newTab(known);
    await until(() => document.querySelector(".sublore-badges button")?.textContent === "Check");
    assert.equal(apiCalls, 0, "Lookups must wait for consent.");
    await openSettings(settings);
    assert.equal(await run(() => document.getElementById("consent").hidden), false);
    await screenshot("settings.png");
    await click("#allow");
    await until(() => document.getElementById("consent").hidden);
    await closeSettings();
    await click(".sublore-badges button");
    await until(() => Boolean(document.querySelector(".sublore-badges a")));
    assert.equal(await run(() => document.querySelector(".sublore-badges a").textContent), "r/Fauxmoi · 79");
    assert.equal(apiCalls, 1);
    await screenshot("thread.png");
    await session("POST", "/refresh", {});
    await until(() => Boolean(document.querySelector(".sublore-badges a")));
    assert.equal(apiCalls, 1);
    const { handle } = await session("POST", "/window/new", { type: "tab" });
    await session("POST", "/window", { handle });
    await session("POST", "/url", { url: optionsUrl });
    await openSettings(handle);
    await run(value => {
      const input = document.getElementById("minCount");
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, "2");
    await click('button[type="submit"]');
    await until(() => document.getElementById("status").textContent === "Settings saved.");
    assert.equal(await run(async () => (await browser.storage.local.get("settings")).settings.minCount), 2);
    await click("#clear");
    await until(() => document.getElementById("status").textContent === "Cache cleared.");
    await closeSettings();
    await until(() => document.querySelector(".sublore-badges button")?.textContent === "Check" && !document.querySelector(".sublore-badges a"));
    assert.equal(apiCalls, 1);
    console.log("Packaged Firefox for Android extension passed: temporary add-on install, settings opened on install and before consent, content injection, consent, lookup, cache hit, options save, and cache clear. A local proxy served Reddit and the API, so no public requests were made.");
  } finally {
    if (sessionId) await session("DELETE", "").catch(() => {});
    driver.kill();
    unmap();
    server.closeAllConnections();
    proxy.close();
    server.close();
  }
// Exit explicitly, because the local proxy keeps Node running when a launch step fails.
})().catch(error => { console.error(error); process.exit(1); });
