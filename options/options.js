"use strict";
(() => {
  const byId = id => document.getElementById(id);
  let watchlist = [];
  async function send(message) {
    const result = await browser.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || "Extension unavailable. Reload this page.");
    return result;
  }
  function status(text) { byId("status").textContent = text; }
  function dirty() { status("Unsaved changes."); }
  function renderList() {
    byId("watchlist").replaceChildren();
    byId("watch-count").textContent = watchlist.length || "";
    if (!watchlist.length) {
      const item = document.createElement("li");
      item.className = "empty-watchlist";
      item.textContent = "No subreddits. Add one or restore the defaults.";
      byId("watchlist").append(item);
      return;
    }
    for (const name of watchlist) {
      const item = document.createElement("li");
      const text = document.createElement("span");
      text.className = "watchlist-name";
      text.textContent = `r/${name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-watch";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove r/${name}`);
      remove.addEventListener("click", () => {
        const index = watchlist.indexOf(name);
        watchlist = watchlist.filter(value => value !== name);
        renderList();
        const buttons = byId("watchlist").querySelectorAll(".remove-watch");
        (buttons[Math.min(index, buttons.length - 1)] || byId("subreddit")).focus();
        dirty();
      });
      item.append(text, remove);
      byId("watchlist").append(item);
    }
  }
  function add() {
    try {
      const name = Sublore.subreddit(byId("subreddit").value);
      if (watchlist.some(value => value.toLowerCase() === name.toLowerCase())) throw new Error("Already in the list.");
      if (watchlist.length >= 500) throw new Error("Use at most 500 watched subreddits.");
      watchlist.push(name);
      renderList();
      byId("subreddit").value = "";
      byId("subreddit").removeAttribute("aria-invalid");
      byId("subreddit-error").textContent = "";
      dirty();
    } catch (error) {
      byId("subreddit-error").textContent = error.message;
      byId("subreddit").setAttribute("aria-invalid", "true");
    }
    byId("subreddit").focus();
  }
  byId("add").addEventListener("click", add);
  byId("subreddit").addEventListener("input", () => {
    byId("subreddit").removeAttribute("aria-invalid");
    byId("subreddit-error").textContent = "";
  });
  byId("subreddit").addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); add(); }
  });
  byId("restore").addEventListener("click", () => {
    watchlist = [...Sublore.defaults.watchlist];
    renderList();
    dirty();
  });
  byId("settings-form").addEventListener("input", dirty);
  byId("settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (byId("subreddit").value.trim()) {
      byId("subreddit-error").textContent = "Add this subreddit or clear the input before saving.";
      byId("subreddit").setAttribute("aria-invalid", "true");
      byId("subreddit").focus();
      return;
    }
    const settings = { watchlist: [...watchlist], intervalMs: Number(byId("intervalSeconds").value) * 1000 };
    const active = document.activeElement;
    for (const key of ["lookbackMonths", "minCount", "maxBadges", "cacheDays"]) settings[key] = Number(byId(key).value);
    byId("controls").disabled = true;
    try {
      await send({ type: "save-settings", settings: Sublore.settings(settings) });
      status("Settings saved.");
    } catch (error) { status(error.message); }
    finally { byId("controls").disabled = false; active?.focus(); }
  });
  byId("clear").addEventListener("click", async () => {
    byId("clear").disabled = true;
    try { await send({ type: "clear-cache" }); status("Cache cleared."); }
    catch (error) { status(error.message); }
    finally { byId("clear").disabled = false; byId("clear").focus(); }
  });
  byId("allow").addEventListener("click", async () => {
    byId("allow").disabled = true;
    try {
      await send({ type: "allow" });
      byId("consent").hidden = true;
      byId("subreddit").focus();
      status("Lookups allowed.");
    } catch (error) { status(error.message); byId("allow").disabled = false; }
  });
  send({ type: "settings" }).then(({ settings, consent }) => {
    byId("consent").hidden = consent;
    watchlist = [...settings.watchlist];
    for (const key of ["lookbackMonths", "minCount", "maxBadges", "cacheDays"]) byId(key).value = settings[key];
    byId("intervalSeconds").value = settings.intervalMs / 1000;
    renderList();
    byId("controls").disabled = false;
    status("");
  }).catch(error => status(error.message));
})();
