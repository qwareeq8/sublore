"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = name => fs.readFileSync(path.join(root, "src", `${name}.js`), "utf8");

class Storage {
  constructor(seed = {}) { this.data = { ...seed }; }
  async get(keys) {
    if (keys === null) return { ...this.data };
    return keys in this.data ? { [keys]: this.data[keys] } : {};
  }
  async set(values) { Object.assign(this.data, values); }
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; }
}

function listeners() {
  const callbacks = [];
  return { addListener: callback => callbacks.push(callback), callbacks };
}

function makePort(id) {
  const messages = listeners();
  const disconnects = listeners();
  let resolve;
  return {
    name: "activity-lookup", sender: { id }, onMessage: messages, onDisconnect: disconnects,
    posted: [],
    response: new Promise(value => { resolve = value; }),
    postMessage(value) { this.posted.push(value); resolve(value); },
    send(value) { for (const callback of messages.callbacks) callback(value); },
    disconnect() { for (const callback of disconnects.callbacks) callback(); },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

function apiResponse(data) {
  return { status: 200, ok: true, headers: new Headers(), json: async () => ({ data }) };
}

function setup({ seed, fetchFn, consent = true } = {}) {
  const storage = new Storage(consent ? { consent: true, ...seed } : seed);
  const connect = listeners();
  const messages = listeners();
  const actions = listeners();
  const browser = {
    storage: { local: storage },
    runtime: {
      id: "sublore@test", onConnect: connect, onMessage: messages,
      getURL: relative => `moz-extension://sublore/${relative}`,
      openOptionsPage: async () => {},
    },
    action: { onClicked: actions },
  };
  const context = vm.createContext({
    browser, fetch: fetchFn || (async () => { throw new Error("This test must not fetch."); }),
    AbortController, Headers, URL, URLSearchParams, TextEncoder, setTimeout, clearTimeout, console,
  });
  for (const name of ["settings", "api", "cache", "scheduler", "background"]) {
    vm.runInContext(source(name), context, { filename: `src/${name}.js` });
  }
  return {
    storage,
    connect: port => { for (const callback of connect.callbacks) callback(port); },
    send: (message, sender = { id: browser.runtime.id }) => new Promise(resolve => messages.callbacks[0](message, sender, resolve)),
    id: browser.runtime.id,
  };
}

test("Lookups wait for consent from the options page.", async () => {
  let calls = 0;
  const app = setup({ consent: false, fetchFn: async () => { calls++; return apiResponse([{ subreddit: "Alpha", count: 1 }]); } });
  const options = { id: app.id, url: "moz-extension://sublore/options/options.html" };
  assert.equal((await app.send({ type: "settings" }, options)).consent, false);
  const blocked = makePort(app.id);
  app.connect(blocked);
  blocked.send({ author: "someone" });
  assert.equal((await blocked.response).consent, true);
  assert.equal(calls, 0);
  assert.equal((await app.send({ type: "allow" }, { id: app.id, url: "https://www.reddit.com/" })).ok, false);
  assert.equal((await app.send({ type: "allow" }, options)).ok, true);
  const allowed = makePort(app.id);
  app.connect(allowed);
  allowed.send({ author: "someone" });
  assert.equal((await allowed.response).ok, true);
  assert.equal(calls, 1);
});

test("The background serves initial cached reads without fetching.", async () => {
  let fetches = 0;
  const now = Date.now();
  const app = setup({
    seed: { "activity:cacheduser": { schema: 1, lookbackMonths: 6, fetchedAt: now, activity: [{ subreddit: "VaushV", count: 4 }] } },
    fetchFn: async () => { fetches++; return apiResponse([]); },
  });
  const settings = await app.send({ type: "settings" });
  const cached = await app.send({ type: "cached", author: "CachedUser" });
  assert.equal(settings.ok, true);
  assert.equal(cached.entry.activity[0].subreddit, "VaushV");
  assert.equal(fetches, 0);
});

test("Lookups reuse cached entries without network access.", async () => {
  let fetches = 0;
  const app = setup({
    seed: { "activity:cacheduser": { schema: 1, lookbackMonths: 6, fetchedAt: Date.now(), activity: [{ subreddit: "VaushV", count: 4 }] } },
    fetchFn: async () => { fetches++; return apiResponse([]); },
  });
  const port = makePort(app.id);
  app.connect(port);
  port.send({ author: "CACHEDUSER" });
  const result = await port.response;
  assert.equal(result.ok, true);
  assert.equal(result.entry.activity[0].count, 4);
  assert.equal(fetches, 0);
});

test("Simultaneous ports deduplicate one normalized author lookup.", async () => {
  let fetches = 0;
  const gate = deferred();
  const started = deferred();
  const app = setup({ fetchFn: async () => { fetches++; started.resolve(); return gate.promise; } });
  const first = makePort(app.id);
  const second = makePort(app.id);
  app.connect(first);
  app.connect(second);
  first.send({ author: "Some_User" });
  second.send({ author: "some_user" });
  await started.promise;
  try {
    assert.equal(fetches, 1);
  } finally {
    gate.resolve(apiResponse([{ subreddit: "VaushV", count: 2 }]));
  }
  const [one, two] = await Promise.all([first.response, second.response]);
  assert.deepEqual(one.entry.activity, two.entry.activity);
  assert.equal(fetches, 1);
});

test("Settings writes require the exact options URL.", async () => {
  const app = setup();
  const payload = { ...await app.send({ type: "settings" }) };
  payload.settings.minCount = 7;
  const denied = await app.send({ type: "save-settings", settings: payload.settings }, { id: app.id, url: "https://www.reddit.com/r/test/" });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /options page/);
  const allowed = await app.send({ type: "save-settings", settings: payload.settings }, { id: app.id, url: "moz-extension://sublore/options/options.html" });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.settings.minCount, 7);
  assert.equal(app.storage.data.settings.minCount, 7);
});

test("A cache quota error preserves the live result and reports that it is not cached.", async () => {
  let calls = 0;
  const app = setup({ fetchFn: async () => { calls++; return apiResponse([{ subreddit: "Fauxmoi", count: 79 }]); } });
  const originalSet = app.storage.set.bind(app.storage);
  app.storage.set = async values => {
    if (Object.keys(values).some(key => key.startsWith("activity:"))) throw new Error("QUOTA_BYTES exceeded.");
    return originalSet(values);
  };
  const port = makePort(app.id);
  app.connect(port);
  port.send({ author: "quotauser" });
  const result = await port.response;
  assert.equal(result.ok, true);
  assert.equal(result.entry.activity[0].count, 79);
  assert.match(result.cacheWarning, /could not be cached/);
  assert.equal(calls, 1);
});

test("Clearing while a fetch is pending prevents the stale result from refilling cache.", async () => {
  const gate = deferred();
  let started = 0;
  const app = setup({ fetchFn: async () => { started++; return gate.promise; } });
  const port = makePort(app.id);
  app.connect(port);
  port.send({ author: "fetchuser" });
  while (!started) await Promise.resolve();
  const cleared = await app.send({ type: "clear-cache" }, { id: app.id, url: "moz-extension://sublore/options/options.html" });
  assert.equal(cleared.ok, true);
  gate.resolve(apiResponse([{ subreddit: "VaushV", count: 8 }]));
  assert.equal((await port.response).ok, true);
  assert.equal(app.storage.data["activity:fetchuser"], undefined);
});

test("A fresh lookup bypasses the cache and replaces the cached entry.", async () => {
  let fetches = 0;
  const app = setup({
    seed: { "activity:cacheduser": { schema: 1, lookbackMonths: 6, fetchedAt: Date.now(), activity: [{ subreddit: "VaushV", count: 4 }] } },
    fetchFn: async () => { fetches++; return apiResponse([{ subreddit: "VaushV", count: 9 }]); },
  });
  const port = makePort(app.id);
  app.connect(port);
  port.send({ author: "cacheduser", fresh: true });
  const result = await port.response;
  assert.equal(result.entry.activity[0].count, 9);
  assert.equal(fetches, 1);
  assert.equal(app.storage.data["activity:cacheduser"].activity[0].count, 9);
});

test("The 7-day check runs only for small activity in the thread's subreddit.", async () => {
  const urls = [];
  const app = setup({ fetchFn: async url => {
    urls.push(new URL(url));
    const recent = urls.length > 1;
    return apiResponse(recent ? [{ subreddit: "Destiny", count: 2 }] : [{ subreddit: "Destiny", count: 2 }, { subreddit: "VaushV", count: 80 }]);
  } });
  const port = makePort(app.id);
  app.connect(port);
  port.send({ author: "newuser", subreddit: "destiny" });
  const result = await port.response;
  assert.equal(urls.length, 2);
  assert.equal(Date.parse(urls[0].searchParams.get("before")) - Date.parse(urls[1].searchParams.get("after")), 7 * 86400000);
  assert.equal(JSON.stringify(result.entry.recent.activity), JSON.stringify([{ subreddit: "Destiny", count: 2 }]));
  assert.equal(JSON.stringify(app.storage.data["activity:newuser"].recent.activity), JSON.stringify([{ subreddit: "Destiny", count: 2 }]));
  for (const subreddit of ["VaushV", "fauxmoi"]) {
    const other = makePort(app.id);
    app.connect(other);
    other.send({ author: "newuser", subreddit, fresh: true });
    await other.response;
  }
  assert.equal(urls.length, 4, "Large or absent subreddit activity skips the recent query.");
});
