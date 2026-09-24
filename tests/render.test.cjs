"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
require("../src/settings.js");
require("../src/render.js");

test("Watched communities match from one interaction, ordered by count.", () => {
  const settings = Sublore.settings();
  assert.equal(settings.minCount, 1);
  const entry = { activity: [
    { subreddit: "Fauxmoi", count: 79 },
    { subreddit: "VaushV", count: 1 },
    { subreddit: "Unwatched", count: 200 },
  ] };
  assert.deepEqual(Sublore.matches(entry, settings), entry.activity.slice(0, 2));
  assert.deepEqual(Sublore.matches(entry, { ...settings, minCount: 3 }), entry.activity.slice(0, 1));
});

test("Settings drop unknown keys.", () => {
  const settings = Sublore.settings({ unknown: true, minCount: 3, watchlist: ["fauxmoi"] });
  assert.equal(Object.hasOwn(settings, "unknown"), false);
  const entry = { activity: [{ subreddit: "Fauxmoi", count: 79 }] };
  assert.deepEqual(Sublore.matches(entry, settings), entry.activity);
});

test("The default watchlist matches only its own subreddits.", () => {
  const entry = { activity: [
    { subreddit: "Destiny", count: 100 },
    { subreddit: "h3h3productions", count: 90 },
    { subreddit: "DGGsnark", count: 8 },
    { subreddit: "Marxism", count: 7 },
    { subreddit: "h3snark", count: 6 },
    { subreddit: "LeftoversH3", count: 5 },
  ] };
  assert.deepEqual(Sublore.matches(entry, Sublore.settings()), entry.activity.slice(2));
  assert.deepEqual(Sublore.matches(entry, Sublore.settings({ watchlist: ["Destiny"] })), entry.activity.slice(0, 1));
});

test("A commenter is new here when all lookback activity in the subreddit is from the recent window.", () => {
  const entry = { activity: [{ subreddit: "Destiny", count: 3 }, { subreddit: "VaushV", count: 40 }],
    recent: { activity: [{ subreddit: "destiny", count: 3 }, { subreddit: "VaushV", count: 2 }] } };
  assert.equal(Sublore.newHere(entry, "Destiny"), "Destiny");
  assert.equal(Sublore.newHere(entry, "VaushV"), null);
  assert.equal(Sublore.newHere(entry, "fauxmoi"), null);
  assert.equal(Sublore.newHere({ activity: entry.activity }, "Destiny"), null);
});
