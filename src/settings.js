"use strict";
globalThis.Sublore = globalThis.Sublore || {};
(() => {
  const defaults = {
    watchlist: ["VaushV", "Hasan_Piker", "BreadTube", "socialism", "communism",
      "communism101", "Socialism_101", "Marxism", "MarxistCulture", "AskCommunists",
      "LateStageCapitalism", "ShitLiberalsSay", "WorkersStrikeBack", "TheDeprogram",
      "TankieTheDeprogram", "Leftist", "Anarchism", "Anarchy101", "COMPLETEANARCHY",
      "DankLeft", "CommunismMemes", "TheRightCantMeme", "LandlordLove",
      "SocialistGaming", "SocialistMusic", "ArmedSocialists", "TransSocialism",
      "USSR", "GreenAndPleasant", "GreenAndEXTREME", "alltheleft", "The_Leftorium",
      "LateStageColonialism", "ShitPatSocsSay", "QueerCommies", "QueerMarxism",
      "TransCommunist", "Tranarchist", "theredleft", "h3snark", "LeftoversH3",
      "DGGsnark", "fauxmoi", "leftoversh3snark", "GenZedong",
      "Conservative", "Republican", "conservatives", "walkaway", "trump",
      "benshapiro", "TimPool", "tucker_carlson", "JordanPeterson", "KotakuInAction",
      "UkraineRussiaReport", "MensRights", "TheRedPill", "BlackPillScience",
      "RedPillWomen", "RedPillWives", "FemaleDatingStrategy"],
    lookbackMonths: 6, minCount: 1, maxBadges: 3, cacheDays: 7,
    intervalMs: 1000,
  };
  function subreddit(value) {
    const name = String(value).trim().replace(/^\/?r\//i, "").replace(/\/$/, "");
    if (!/^[a-z0-9_]{2,21}$/i.test(name)) throw new Error("Enter a subreddit name with 2 to 21 letters, digits, or underscores.");
    return name;
  }
  function username(value) {
    if (typeof value !== "string" || !/^[a-z0-9_-]{1,20}$/i.test(value) || /^(deleted|removed)$/i.test(value)) {
      throw new Error("This author cannot be looked up.");
    }
    return value.toLowerCase();
  }
  function settings(input = {}) {
    const result = { ...defaults, ...input };
    if (!Array.isArray(result.watchlist) || result.watchlist.length > 500) throw new Error("Use at most 500 watched subreddits.");
    const unique = new Map();
    for (const value of result.watchlist) {
      const name = subreddit(value);
      if (!unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
    }
    result.watchlist = [...unique.values()];
    for (const [key, label, min, max, scale = 1] of [["lookbackMonths", "Lookback", 1, 120],
      ["minCount", "Minimum activity", 1, 1000000], ["maxBadges", "Visible badges", 1, 10],
      ["cacheDays", "Cache lifetime", 1, 30], ["intervalMs", "Request interval", 1000, 60000, 1000]]) {
      if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) {
        throw new Error(`${label} must be a whole number from ${min / scale} to ${max / scale}.`);
      }
    }
    return Object.fromEntries(Object.keys(defaults).map(key => [key, result[key]]));
  }
  function windowStart(now, months) {
    const date = new Date(now);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - months);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
    return date.toISOString();
  }
  Object.assign(Sublore, { defaults, subreddit, username, settings, windowStart });
})();
