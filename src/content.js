"use strict";
(() => {
  const states = new Map();
  const decorations = new Map();
  let settings;
  let revision = 0;
  let path = location.pathname;
  let timer;
  const pendingRoots = new Set();
  async function message(payload) {
    const result = await browser.runtime.sendMessage(payload);
    if (!result?.ok) throw new Error(result?.error || "Extension unavailable. Reload this page to retry.");
    return result;
  }
  function repaint(author) {
    for (const [link, item] of decorations) {
      if (!link.isConnected || !item.host.isConnected) { item.host.remove(); decorations.delete(link); continue; }
      if (!author || item.author === author) {
        Sublore.render(item.host, states.get(item.author), settings, options => load(item.author, options));
      }
    }
  }
  function request(author, fresh) {
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: "activity-lookup" });
      let settled = false;
      // Active port traffic keeps Chrome's worker alive only during this lookup.
      const heartbeat = setInterval(() => {
        try { port.postMessage({ type: "ping" }); } catch { clearInterval(heartbeat); }
      }, 20000);
      const timeout = setTimeout(() => {
        settled = true;
        clearInterval(heartbeat);
        port.disconnect();
        reject(new Error("The queue took too long. Try again later."));
      }, 180000);
      port.onMessage.addListener(result => {
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        port.disconnect();
        resolve(result);
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        if (!settled) reject(new Error("Lookup interrupted. Click to retry."));
      });
      port.postMessage({ author, fresh, subreddit: Sublore.currentSubreddit() });
    });
  }
  async function load(author, { fresh = false } = {}) {
    const previous = states.get(author);
    if (previous?.status === "loading") return;
    if (previous?.retryAt > Date.now()) { repaint(author); return; }
    const version = revision;
    states.set(author, { author, status: "loading" });
    repaint(author);
    try {
      const result = await request(author, fresh);
      if (version !== revision) return;
      if (result.consent) {
        states.set(author, { author, status: "idle" });
        repaint(author);
        await message({ type: "open-settings" });
        return;
      }
      states.set(author, result.ok ? { author, status: "ready", entry: result.entry, cacheWarning: result.cacheWarning }
        : { author, status: "error", error: result.error, retryAt: result.retryAt });
    } catch (error) {
      if (version !== revision) return;
      states.set(author, { author, status: "error", error: error.message });
    }
    const retryAt = states.get(author)?.retryAt;
    if (retryAt > Date.now()) setTimeout(() => repaint(author), retryAt - Date.now() + 50);
    repaint(author);
  }
  async function cached(author) {
    const version = revision;
    try {
      const result = await message({ type: "cached", author });
      if (version !== revision || states.get(author)?.status !== "idle") return;
      if (result.entry) states.set(author, { author, status: "ready", entry: result.entry });
    } catch (error) {
      if (version !== revision || states.get(author)?.status !== "idle") return;
      states.set(author, { author, status: "error", error: error.message });
    }
    repaint(author);
  }
  function scan(root) {
    if (!settings || !Sublore.isThread()) return;
    for (const { link, author } of Sublore.discover(root)) {
      const old = decorations.get(link);
      if (old?.author === author && old.host.isConnected) continue;
      old?.host.remove();
      const host = document.createElement("span");
      host.className = "sublore-badges";
      host.setAttribute("aria-live", "polite");
      // Place badges outside Reddit's profile hover-card trigger so focus and clicks do not open it.
      const anchor = link.closest(".author-hovercard-trigger") || link.closest("faceplate-hovercard") || link;
      if (anchor.hasAttribute("slot")) host.setAttribute("slot", anchor.getAttribute("slot"));
      anchor.after(host);
      decorations.set(link, { host, author });
      if (!states.has(author)) {
        states.set(author, { author, status: "idle" });
        void cached(author);
      }
      Sublore.render(host, states.get(author), settings, options => load(author, options));
    }
  }
  function reset() {
    revision++;
    for (const { host } of decorations.values()) host.remove();
    decorations.clear();
    states.clear();
    scan(document);
  }
  function flush() {
    timer = null;
    if (path !== location.pathname) {
      path = location.pathname;
      pendingRoots.clear();
      reset();
      return;
    }
    for (const [link, item] of decorations) {
      if (!link.isConnected || Sublore.profileName(link) !== item.author) {
        item.host.remove();
        decorations.delete(link);
      }
    }
    for (const root of pendingRoots) if (root.isConnected) scan(root);
    pendingRoots.clear();
    const visible = new Set([...decorations.values()].map(item => item.author));
    for (const [author, state] of states) if (!visible.has(author) && state.status !== "loading") states.delete(author);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.target.nodeType === 1 && record.target.closest(".sublore-badges")) continue;
      if (record.type === "attributes") pendingRoots.add(record.target);
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && !node.matches(".sublore-badges") && !node.closest(".sublore-badges")) pendingRoots.add(node);
      }
    }
    if (!timer && (pendingRoots.size || path !== location.pathname || records.some(record => record.removedNodes.length))) {
      timer = setTimeout(flush, 80);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["href", "author", "data-author"] });
  window.addEventListener("popstate", () => { if (!timer) timer = setTimeout(flush, 0); });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      settings = Sublore.settings(changes.settings.newValue);
      reset();
    } else if (changes.cacheClearedAt) reset();
    else {
      for (const key of Object.keys(changes)) {
        if (!key.startsWith("activity:")) continue;
        const author = key.slice(9);
        if (!states.has(author) || states.get(author).status === "loading") continue;
        states.set(author, { author, status: "idle" });
        void cached(author);
      }
    }
  });
  message({ type: "settings" }).then(result => { settings = result.settings; scan(document); })
    .catch(error => { console.warn("Sublore:", error.message); });
})();
