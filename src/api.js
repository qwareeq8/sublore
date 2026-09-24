"use strict";
(() => {
  class ApiError extends Error {
    constructor(message, { retryable = false, retryAt = 0, status = 0 } = {}) {
      super(message);
      Object.assign(this, { retryable, retryAt, status });
    }
  }
  function retryAt(headers, now) {
    const dates = [now];
    const retry = headers.get("Retry-After");
    if (retry !== null) dates.push(/^\d+(\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry));
    const reset = headers.get("X-RateLimit-Reset");
    if (reset !== null && Number.isFinite(Number(reset))) dates.push(now + Number(reset) * 1000);
    const at = headers.get("X-RateLimit-Reset-At");
    if (at !== null) {
      const value = Number(at);
      dates.push(Number.isFinite(value) ? value * (value < 1e12 ? 1000 : 1) : Date.parse(at));
    }
    return Math.max(...dates.filter(Number.isFinite));
  }
  function parseActivity(body) {
    if (!body || !Array.isArray(body.data)) throw new ApiError("Arctic Shift returned an unexpected response.");
    // The archive can list one subreddit under several capitalizations; their counts are summed.
    const rows = new Map();
    for (const row of body.data) {
      // Archive results also include profile communities and legacy reddit.com.
      if (!row || typeof row.subreddit !== "string" || !/^[a-z0-9_.-]{1,100}$/i.test(row.subreddit)
        || !Number.isSafeInteger(row.count) || row.count < 0) {
        throw new ApiError("Arctic Shift returned invalid activity counts.");
      }
      const key = row.subreddit.toLowerCase();
      const existing = rows.get(key);
      if (existing) existing.count += row.count;
      else rows.set(key, { subreddit: row.subreddit, count: row.count });
    }
    return [...rows.values()];
  }
  async function fetchActivity(author, months, { fetchFn = fetch, now = Date.now(), signal, after = Sublore.windowStart(now, months) } = {}) {
    const before = new Date(now).toISOString();
    const url = new URL("https://arctic-shift.photon-reddit.com/api/users/interactions/subreddits");
    url.search = new URLSearchParams({ author: Sublore.username(author), after, before,
      weight_posts: "1", weight_comments: "1", min_count: "1", limit: "" });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetchFn(url.href, { credentials: "omit", referrerPolicy: "no-referrer",
        cache: "no-store", redirect: "error", signal: controller.signal });
      const deadline = retryAt(response.headers, Date.now());
      if (response.status === 429) throw new ApiError("Arctic Shift is rate limited. Try again after the cooldown.",
        { status: 429, retryAt: Math.max(deadline, Date.now() + 30000) });
      // X-RateLimit headers arrive on every response; only 429 or Retry-After means wait.
      const wait = response.headers.has("Retry-After") ? deadline : 0;
      if (response.status === 422) throw new ApiError("Arctic Shift timed out on this account. Try again, or use a shorter lookback.",
        { status: 422, retryable: true, retryAt: wait });
      if (!response.ok) throw new ApiError(`Arctic Shift request failed (HTTP ${response.status}).`,
        { status: response.status, retryable: response.status >= 500, retryAt: wait });
      let body;
      try { body = await response.json(); } catch { throw new ApiError("Arctic Shift returned invalid JSON."); }
      return { activity: parseActivity(body), after, before, fetchedAt: now, lookbackMonths: months, schema: 1 };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) throw new ApiError("Lookup canceled.");
      throw new ApiError(error.name === "AbortError" ? "Arctic Shift timed out. Try a shorter lookback." : "Could not reach Arctic Shift. Check your connection and extension site access.", { retryable: true });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  Object.assign(Sublore, { ApiError, retryAt, parseActivity, fetchActivity });
})();
