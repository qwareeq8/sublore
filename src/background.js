"use strict";
(() => {
  const cache = new Sublore.ActivityCache(browser.storage.local);
  let current = Sublore.settings();
  const ready = browser.storage.local.get("settings").then(data => { current = Sublore.settings(data.settings); });
  const scheduler = new Sublore.RequestScheduler({ storage: browser.storage.local, interval: () => current.intervalMs });
  const failure = error => ({ ok: false, error: error.message || "The lookup failed. Try again.", retryAt: error.retryAt || 0,
    consent: error.consent === true });
  const optionsUrl = browser.runtime.getURL("options/options.html");
  // Chrome Web Store policy requires consent inside the extension before usernames leave the browser.
  const consented = async () => (await browser.storage.local.get("consent")).consent === true;
  const recentDays = 7;
  const recentMaxCount = 50;
  async function store(author, entry, generation) {
    try { if (await cache.put(author, entry, generation)) return ""; } catch { /* The live result remains usable if local storage is full. */ }
    return "This result could not be cached locally.";
  }
  // One extra 7-day query marks people who are new to the thread's subreddit.
  // It is skipped above recentMaxCount, where someone is clearly established.
  async function addRecent(author, entry, subreddit, generation, signal) {
    const row = subreddit && entry.activity.find(item => item.subreddit.toLowerCase() === subreddit.toLowerCase());
    if (!row || row.count > recentMaxCount || entry.recent) return "";
    const after = new Date(entry.fetchedAt - recentDays * 86400000).toISOString();
    const recent = await scheduler.run(`${author}:recent:${entry.fetchedAt}:${generation}`, requestSignal =>
      Sublore.fetchActivity(author, 0, { signal: requestSignal, now: entry.fetchedAt, after }), { signal });
    entry.recent = { after, activity: recent.activity };
    return store(author, entry, generation);
  }
  async function lookup(message, signal) {
    await ready;
    if (!await consented()) throw Object.assign(new Error("Allow lookups in Sublore settings first."), { consent: true });
    const author = Sublore.username(message?.author);
    let subreddit = null;
    try { if (message?.subreddit) subreddit = Sublore.subreddit(message.subreddit); } catch { /* Ignore a malformed page subreddit. */ }
    const fresh = message?.fresh === true;
    const settings = current;
    const generation = cache.generation;
    let entry = fresh ? null : await cache.get(author, settings);
    let cacheWarning = "";
    if (!entry) {
      const result = await scheduler.run(`${author}:${settings.lookbackMonths}:${generation}${fresh ? ":fresh" : ""}`, async requestSignal => {
        const hit = fresh ? null : await cache.get(author, settings);
        if (hit) return { entry: hit, cacheWarning: "" };
        const live = await Sublore.fetchActivity(author, settings.lookbackMonths, { signal: requestSignal });
        return { entry: live, cacheWarning: await store(author, live, generation) };
      }, { signal });
      ({ entry, cacheWarning } = result);
    }
    try { cacheWarning = await addRecent(author, entry, subreddit, generation, signal) || cacheWarning; } catch { /* Badges still render without the new-poster check. */ }
    return { ok: true, entry, cacheWarning };
  }
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== "activity-lookup" || port.sender?.id !== browser.runtime.id) return;
    let used = false;
    let connected = true;
    const controller = new AbortController();
    port.onDisconnect.addListener(() => { connected = false; controller.abort(); });
    port.onMessage.addListener(message => {
      if (used) return;
      used = true;
      lookup(message, controller.signal).catch(failure).then(result => {
        if (connected) port.postMessage(result);
      }).catch(() => {});
    });
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return;
    (async () => {
      await ready;
      switch (message?.type) {
        case "settings": return { ok: true, settings: current, consent: await consented() };
        case "cached": return { ok: true, entry: await cache.get(message.author, current) };
        case "open-settings": await browser.runtime.openOptionsPage(); return { ok: true };
        case "allow": {
          if (sender.url !== optionsUrl) throw new Error("Allow lookups in the settings page.");
          await browser.storage.local.set({ consent: true });
          return { ok: true };
        }
        case "save-settings": {
          if (sender.url !== optionsUrl) throw new Error("Settings can only be changed in the options page.");
          const next = Sublore.settings(message.settings);
          await browser.storage.local.set({ settings: next });
          current = next;
          return { ok: true, settings: current };
        }
        case "clear-cache": {
          if (sender.url !== optionsUrl) throw new Error("Open settings to clear the cache.");
          await cache.clear();
          return { ok: true };
        }
        default: throw new Error("Unknown extension request.");
      }
    })().catch(failure).then(sendResponse);
    return true;
  });
  browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());
  browser.runtime.onInstalled?.addListener(({ reason }) => { if (reason === "install") browser.runtime.openOptionsPage(); });
})();
