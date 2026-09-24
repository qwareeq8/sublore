"use strict";
(() => {
  function button(label, title, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "sublore-pill";
    element.textContent = label;
    if (title) element.title = title;
    element.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); action(); });
    return element;
  }
  function link(href) {
    const element = document.createElement("a");
    element.href = href;
    element.target = "_blank";
    element.rel = "noopener noreferrer";
    element.addEventListener("click", event => event.stopPropagation());
    return element;
  }
  function matches(entry, settings) {
    const watched = new Set(settings.watchlist.map(name => name.toLowerCase()));
    return entry.activity.filter(row => watched.has(row.subreddit.toLowerCase()) && row.count >= settings.minCount)
      .sort((a, b) => b.count - a.count || a.subreddit.localeCompare(b.subreddit));
  }
  // A seedling icon, built as DOM nodes so it works under Trusted Types.
  function sprout() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ["M8 15V8.5", "M8 9.5C8 6.5 6 4.5 2.5 4.5C2.5 7.5 4.5 9.5 8 9.5Z", "M8 7.5C8 4.5 10 2.5 13.5 2.5C13.5 5.5 11.5 7.5 8 7.5Z"]) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  // New here: all lookback activity in the thread's subreddit falls inside the 7-day recent window.
  function newHere(entry, subreddit) {
    if (!subreddit || !entry.recent) return null;
    const key = subreddit.toLowerCase();
    const row = entry.activity.find(item => item.subreddit.toLowerCase() === key);
    const recent = entry.recent.activity.find(item => item.subreddit.toLowerCase() === key);
    return row && recent && recent.count >= row.count ? row.subreddit : null;
  }
  // Arctic Shift author and subreddit searches often time out without a date range.
  function searchUrl(subreddit, author, after) {
    const url = new URL("https://arctic-shift.photon-reddit.com/search");
    const params = { fun: "comments_search", subreddit, author, limit: "25", sort: "desc" };
    if (typeof after === "string") params.after = after.slice(0, 10);
    url.search = new URLSearchParams(params);
    return url.href;
  }
  function render(host, state, settings, load) {
    const hadFocus = host.contains(document.activeElement);
    host.replaceChildren();
    host.setAttribute("aria-busy", String(state.status === "loading"));
    if (state.status === "ready") {
      const rows = matches(state.entry, settings);
      const months = `${settings.lookbackMonths} ${settings.lookbackMonths === 1 ? "month" : "months"}`;
      const checked = new Date(state.entry.fetchedAt).toLocaleDateString();
      const recheck = button("↻", [`Last checked ${checked}`, state.cacheWarning].filter(Boolean).join(". "), () => load({ fresh: true }));
      recheck.classList.add("sublore-recheck");
      recheck.setAttribute("aria-label", `Recheck u/${state.author}`);
      host.append(recheck);
      const fresh = newHere(state.entry, Sublore.currentSubreddit());
      if (fresh) {
        const mark = link(searchUrl(fresh, state.author, state.entry.recent.after));
        mark.className = "sublore-new";
        mark.title = `New to r/${fresh}: all activity there is from the last 7 days`;
        mark.setAttribute("aria-label", mark.title);
        mark.append(sprout());
        host.append(mark);
      }
      if (!rows.length) {
        const empty = document.createElement("span");
        empty.className = "sublore-empty";
        empty.textContent = state.entry.activity.length ? "No matches" : "No archive data";
        empty.title = state.entry.activity.length ? "No activity in your watched subreddits"
          : `No archived activity in the last ${months}`;
        empty.tabIndex = 0;
        host.append(empty);
      }
      for (const row of rows.slice(0, state.expanded ? rows.length : settings.maxBadges)) {
        const pill = link(searchUrl(row.subreddit, state.author, state.entry.after));
        pill.className = "sublore-pill";
        pill.dataset.subreddit = row.subreddit;
        pill.textContent = `r/${row.subreddit} · ${row.count}`;
        pill.title = `Posts and comments in the last ${months}`;
        host.append(pill);
      }
      if (rows.length > settings.maxBadges) {
        const expand = button(state.expanded ? "Less" : `+${rows.length - settings.maxBadges}`,
          state.expanded ? "Show fewer" : "Show all", () => {
            state.expanded = !state.expanded;
            render(host, state, settings, load);
            host.querySelector("[aria-expanded]")?.focus();
          });
        expand.setAttribute("aria-expanded", String(Boolean(state.expanded)));
        host.append(expand);
      }
    } else if (state.status === "loading") {
      const loading = button("Loading...", "", () => {});
      loading.setAttribute("aria-disabled", "true");
      host.append(loading);
    } else if (state.status === "error") {
      if (state.retryAt > Date.now()) {
        const time = new Date(state.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const wait = button(`Retry at ${time}`, state.error, load);
        wait.setAttribute("aria-disabled", "true");
        host.append(wait);
      } else host.append(button("Retry", state.error, load));
    } else {
      host.append(button("Check", `Look up u/${state.author}`, load));
    }
    if (hadFocus) (host.querySelector("a[data-subreddit]") || host.querySelector("a") || host.querySelector("button:not(.sublore-recheck), [tabindex]") || host.querySelector("button"))?.focus();
  }
  Object.assign(Sublore, { render, matches, newHere });
})();
