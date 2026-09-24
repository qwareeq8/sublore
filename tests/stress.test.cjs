"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
for (const file of ["settings", "api", "cache", "scheduler"]) require(`../src/${file}.js`);
const bytes = values => new TextEncoder().encode(JSON.stringify(values)).length;
class Storage {
  constructor(limit = Infinity) { this.data = {}; this.limit = limit; this.peak = 0; }
  async get(key) { return key === null ? { ...this.data } : { [key]: this.data[key] }; }
  async set(values) {
    const next = { ...this.data, ...values };
    const size = bytes(next);
    if (size > this.limit) throw new Error("QUOTA_BYTES exceeded.");
    this.peak = Math.max(this.peak, size);
    this.data = next;
  }
  async remove(keys) { for (const key of keys) delete this.data[key]; }
}
function clockScheduler(storage = new Storage()) {
  let time = 1000;
  return { scheduler: new Sublore.RequestScheduler({ storage, now: () => time, interval: () => 1000,
    sleep: async ms => { time += ms; } }), now: () => time };
}

test("Two thousand simultaneous clicks deduplicate into 20 serial API requests.", async () => {
  const { scheduler, now } = clockScheduler();
  const starts = [];
  let active = 0;
  let peak = 0;
  const clicks = Array.from({ length: 2000 }, (_, i) => scheduler.run(`author${i % 20}`, async () => {
    starts.push(now()); peak = Math.max(peak, ++active);
    await Promise.resolve(); active--; return "ok";
  }));
  assert.equal((await Promise.all(clicks)).length, 2000);
  assert.equal(starts.length, 20);
  assert.equal(peak, 1);
  assert.ok(starts.slice(1).every((start, i) => start - starts[i] >= 1000));
});

test("The 50-job cap accepts duplicates and rejects excess unique jobs.", async () => {
  const { scheduler } = clockScheduler();
  const jobs = Array.from({ length: 50 }, (_, i) => scheduler.run(`user${i}`, async () => i));
  assert.strictEqual(scheduler.run("user0", () => assert.fail()), jobs[0]);
  const excess = await Promise.allSettled(Array.from({ length: 500 }, (_, i) => scheduler.run(`extra${i}`, () => assert.fail())));
  assert.ok(excess.every(item => item.status === "rejected" && /queue is full/.test(item.reason.message)));
  assert.equal((await Promise.all(jobs)).length, 50);
});

test("A 429 prevents the remaining queued requests from reaching the API.", async () => {
  const { scheduler, now } = clockScheduler();
  let calls = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => scheduler.run(`user${i}`, async () => {
    calls++; throw new Sublore.ApiError("Rate limited.", { status: 429, retryAt: now() + 60000 });
  })));
  assert.equal(calls, 1);
  assert.ok(outcomes.every(item => item.status === "rejected" && item.reason.retryAt > now()));
});

test("Abandoned queued jobs free capacity and never reach the API.", async () => {
  const { scheduler } = clockScheduler();
  const signals = Array.from({ length: 50 }, () => new AbortController());
  const jobs = signals.map((controller, i) => scheduler.run(`user${i}`, () => assert.fail("Abandoned task ran."), { signal: controller.signal }));
  for (const controller of signals) controller.abort();
  assert.equal(scheduler.pending.size, 0);
  const outcomes = await Promise.allSettled(jobs);
  assert.ok(outcomes.every(item => item.status === "rejected" && /canceled/.test(item.reason.message)));
  assert.equal(await scheduler.run("new", async () => "ok"), "ok");
});

test("One disconnected consumer does not cancel a shared lookup.", async () => {
  const { scheduler } = clockScheduler();
  const first = new AbortController();
  const second = new AbortController();
  const work = scheduler.run("same", async signal => { assert.equal(signal.aborted, false); return "ok"; }, { signal: first.signal });
  assert.strictEqual(scheduler.run("same", () => assert.fail(), { signal: second.signal }), work);
  first.abort();
  assert.equal(await work, "ok");
});

test("The cache remains below its byte and record budgets under 1,000 writes.", async () => {
  const storage = new Storage(5 * 1024 * 1024);
  const cache = new Sublore.ActivityCache(storage);
  for (let i = 0; i < 1000; i++) {
    await cache.put(`user${i}`, { schema: 1, lookbackMonths: 6, fetchedAt: i,
      activity: Array.from({ length: 200 }, (_, index) => ({ subreddit: `subreddit_${index}`, count: index + 1 })) }, cache.generation);
  }
  assert.ok(Object.keys(storage.data).length <= 500);
  assert.ok(storage.peak < 4 * 1024 * 1024 + 4096);
  assert.ok(storage.data["activity:user999"]);
  const prior = Object.keys(storage.data).length;
  assert.equal(await cache.put("oversized", { activity: "x".repeat(4 * 1024 * 1024) }, cache.generation), false);
  assert.equal(Object.keys(storage.data).length, prior);
});
