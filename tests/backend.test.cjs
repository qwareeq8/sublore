"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

globalThis.Sublore = {};
for (const name of ["settings", "api", "cache", "scheduler"]) {
  require(path.join(__dirname, "..", "src", `${name}.js`));
}

class MemoryStorage {
  constructor(seed = {}) { this.data = { ...seed }; }
  async get(keys) {
    if (keys === null) return { ...this.data };
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => key in this.data).map(key => [key, this.data[key]]));
    return keys in this.data ? { [keys]: this.data[keys] } : {};
  }
  async set(values) { Object.assign(this.data, values); }
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; }
}

function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => body };
}

function apiError(message, options) { return new Sublore.ApiError(message, options); }

test("Settings normalize unique defaults and validate editable watchlists.", () => {
  const settings = Sublore.settings();
  assert.equal(new Set(settings.watchlist.map(name => name.toLowerCase())).size, Sublore.defaults.watchlist.length);
  assert.deepEqual(Sublore.settings({ watchlist: ["r/Alpha", "alpha", "Beta/"] }).watchlist, ["Alpha", "Beta"]);
  assert.throws(() => Sublore.settings({ watchlist: "alpha" }), /at most 500/);
  assert.throws(() => Sublore.settings({ watchlist: ["a"] }), /2 to 21/);
  assert.throws(() => Sublore.settings({ minCount: 0 }), /Minimum activity must be a whole number from 1/);
  assert.throws(() => Sublore.settings({ watchlist: Array.from({ length: 501 }, (_, i) => `sub_${i}`) }), /at most 500/);
});

test("windowStart clamps calendar months at their last day.", () => {
  assert.equal(Sublore.windowStart(Date.UTC(2024, 2, 31, 12), 1), "2024-02-29T12:00:00.000Z");
  assert.equal(Sublore.windowStart(Date.UTC(2023, 2, 31, 12), 1), "2023-02-28T12:00:00.000Z");
});

test("fetchActivity sends the documented query and parses Arctic Shift data.", async () => {
  const now = Date.UTC(2024, 5, 30, 8, 9, 10);
  let request;
  const result = await Sublore.fetchActivity("Some_User", 6, {
    now,
    fetchFn: async (url, options) => {
      request = { url: new URL(url), options };
      return response(200, { data: [{ subreddit: "Alpha", count: 2 }] });
    },
  });
  assert.equal(request.url.searchParams.get("author"), "some_user");
  assert.equal(request.url.searchParams.get("after"), Sublore.windowStart(now, 6));
  assert.equal(request.url.searchParams.get("before"), new Date(now).toISOString());
  assert.equal(request.url.searchParams.get("weight_posts"), "1");
  assert.equal(request.url.searchParams.get("weight_comments"), "1");
  assert.equal(request.url.searchParams.get("limit"), "");
  assert.equal(request.options.credentials, "omit");
  assert.deepEqual(result.activity, [{ subreddit: "Alpha", count: 2 }]);
});

test("API rejects invalid schemas, HTTP failures, and network failures while accepting empty data.", async () => {
  await assert.rejects(() => Sublore.fetchActivity("author", 1, { fetchFn: async () => response(200, {}) }), /unexpected response/);
  await assert.rejects(() => Sublore.fetchActivity("author", 1, { fetchFn: async () => response(200, { data: [{ subreddit: "bad/name", count: 1 }] }) }), /invalid activity/);
  assert.deepEqual(Sublore.parseActivity({ data: [{ subreddit: "FortniteBR", count: 9 }, { subreddit: "FortNiteBR", count: 4 }] }),
    [{ subreddit: "FortniteBR", count: 13 }]);
  const resetHeaders = { "X-RateLimit-Reset": "37", "X-RateLimit-Reset-At": String(Date.now() + 37_000) };
  await assert.rejects(() => Sublore.fetchActivity("author", 1, { fetchFn: async () => new Response("{}", { status: 422, headers: resetHeaders }) }),
    error => error.status === 422 && error.retryable && error.retryAt === 0);
  await assert.rejects(() => Sublore.fetchActivity("author", 1, { fetchFn: async () => new Response("{}", { status: 500, headers: resetHeaders }) }),
    error => error.status === 500 && error.retryAt === 0);
  assert.deepEqual(Sublore.parseActivity({ data: [{ subreddit: "u_profile-with-hyphen", count: 1 },
    { subreddit: "reddit.com", count: 2 }] }).map(row => row.count), [1, 2]);
  await assert.rejects(() => Sublore.fetchActivity("author", 1, { fetchFn: async () => response(404, {}) }), error => error.status === 404 && !error.retryable);
  const empty = await Sublore.fetchActivity("author", 1, { fetchFn: async () => response(200, { data: [] }) });
  assert.deepEqual(empty.activity, []);
  await assert.rejects(() => Sublore.fetchActivity("author", 1, { fetchFn: async () => { throw new Error("offline"); } }), error => error.retryable && /Could not reach/.test(error.message));
});

test("Rate-limit deadlines support seconds, epoch milliseconds, and Retry-After.", async () => {
  const now = 1_700_000_000_000;
  assert.equal(Sublore.retryAt(new Headers({ "X-RateLimit-Reset": "12" }), now), now + 12_000);
  assert.equal(Sublore.retryAt(new Headers({ "X-RateLimit-Reset-At": "1700000012345" }), now), 1_700_000_012_345);
  assert.equal(Sublore.retryAt(new Headers({ "Retry-After": "7.5" }), now), now + 7_500);
  const oldNow = Date.now;
  Date.now = () => now;
  try {
    await assert.rejects(() => Sublore.fetchActivity("author", 1, {
      now,
      fetchFn: async () => response(429, {}, { "Retry-After": "7", "X-RateLimit-Reset": "12" }),
    }), error => error.status === 429 && error.retryAt === now + 30_000);
  } finally { Date.now = oldNow; }
});

test("ActivityCache applies TTL and lookback validation, including valid empty arrays.", async () => {
  let clock = 10_000;
  const storage = new MemoryStorage({
    "activity:author": { schema: 1, lookbackMonths: 6, fetchedAt: clock, activity: [] },
  });
  const cache = new Sublore.ActivityCache(storage, () => clock);
  const settings = Sublore.settings({ lookbackMonths: 6, cacheDays: 1 });
  assert.deepEqual(await cache.get("author", settings), storage.data["activity:author"]);
  assert.equal(await cache.get("author", { ...settings, lookbackMonths: 5 }), null);
  clock += 86_400_000;
  assert.equal(await cache.get("author", settings), null);
});

test("Cancellation cannot discard a received rate-limit deadline.", async () => {
  const controller = new AbortController();
  await assert.rejects(() => Sublore.fetchActivity("author", 6, {
    signal: controller.signal,
    fetchFn: async () => {
      controller.abort();
      return response(429, {}, { "Retry-After": "60" });
    },
  }), error => error.status === 429 && error.retryAt > Date.now());
});

test("ActivityCache clear invalidates inflight stale puts and removes cached entries.", async () => {
  let clock = 1_000;
  const storage = new MemoryStorage({ "activity:old": { schema: 1, lookbackMonths: 1, fetchedAt: 0, activity: [] } });
  const cache = new Sublore.ActivityCache(storage, () => clock);
  const oldGeneration = cache.generation;
  await cache.clear();
  await cache.put("author", { schema: 1, lookbackMonths: 1, fetchedAt: clock, activity: [] }, oldGeneration);
  assert.equal(storage.data["activity:old"], undefined);
  assert.equal(storage.data["activity:author"], undefined);
  assert.equal(storage.data.cacheClearedAt, clock);
});

test("RequestScheduler deduplicates callers and spaces serial starts by interval.", async () => {
  let clock = 0;
  const starts = [];
  const scheduler = new Sublore.RequestScheduler({
    storage: new MemoryStorage(), interval: () => 100, now: () => clock,
    sleep: async ms => { clock += ms; },
  });
  const first = scheduler.run("same", async () => { starts.push(clock); return "one"; });
  const duplicate = scheduler.run("same", async () => { throw new Error("should not run"); });
  const second = scheduler.run("next", async () => { starts.push(clock); return "two"; });
  assert.strictEqual(first, duplicate);
  assert.deepEqual(await Promise.all([first, duplicate, second]), ["one", "one", "two"]);
  assert.deepEqual(starts, [0, 100]);
});

test("RequestScheduler retries retryable network and 5xx errors at most three times.", async () => {
  let clock = 0;
  const scheduler = new Sublore.RequestScheduler({
    storage: new MemoryStorage(), interval: () => 0, now: () => clock,
    sleep: async ms => { clock += ms; },
  });
  let networkAttempts = 0;
  const network = await scheduler.run("network", async () => {
    networkAttempts++;
    if (networkAttempts < 3) throw apiError("network", { retryable: true });
    return "recovered";
  });
  assert.equal(network, "recovered");
  assert.equal(networkAttempts, 3);
  let serverAttempts = 0;
  await assert.rejects(() => scheduler.run("server", async () => {
    serverAttempts++;
    throw apiError("server", { retryable: true, status: 503 });
  }), /server/);
  assert.equal(serverAttempts, 3);
});

test("RequestScheduler persists 429 cooldowns and permits later retries without poisoning its queue.", async () => {
  let clock = 1_000;
  const storage = new MemoryStorage();
  const scheduler = new Sublore.RequestScheduler({ storage, interval: () => 0, now: () => clock, sleep: async () => {} });
  await assert.rejects(() => scheduler.run("limited", async () => { throw apiError("limited", { status: 429, retryAt: 5_000 }); }), /limited/);
  const restored = new Sublore.RequestScheduler({ storage, interval: () => 0, now: () => clock, sleep: async () => {} });
  let called = false;
  await assert.rejects(() => restored.run("blocked", async () => { called = true; }), error => error.retryAt === 5_000);
  assert.equal(called, false);
  clock = 5_000;
  assert.equal(await restored.run("later", async () => "ok"), "ok");
  await assert.rejects(() => restored.run("failure", async () => { throw apiError("ordinary failure"); }), /ordinary failure/);
  assert.equal(await restored.run("after-failure", async () => "still works"), "still works");
});
