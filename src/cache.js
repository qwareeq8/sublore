"use strict";
(() => {
  const prefix = "activity:";
  const maxBytes = 4 * 1024 * 1024;
  const size = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).length;
  class ActivityCache {
    constructor(storage, now = Date.now) {
      this.storage = storage;
      this.now = now;
      this.generation = 0;
      this.tail = Promise.resolve();
    }
    mutate(action) {
      const result = this.tail.then(action);
      this.tail = result.catch(() => {});
      return result;
    }
    async get(author, settings) {
      await this.tail;
      const key = prefix + Sublore.username(author);
      const entry = (await this.storage.get(key))[key];
      if (!entry || entry.schema !== 1 || entry.lookbackMonths !== settings.lookbackMonths
        || !Number.isFinite(entry.fetchedAt) || this.now() < entry.fetchedAt
        || this.now() - entry.fetchedAt >= settings.cacheDays * 86400000) return null;
      try { Sublore.parseActivity({ data: entry.activity }); } catch { return null; }
      if (entry.recent) {
        try { Sublore.parseActivity({ data: entry.recent.activity }); } catch { delete entry.recent; }
      }
      return entry;
    }
    put(author, entry, generation) {
      return this.mutate(async () => {
        if (generation !== this.generation) return false;
        const key = prefix + Sublore.username(author);
        let bytes = size(key, entry);
        if (bytes > maxBytes) return false;
        const all = await this.storage.get(null);
        const keys = Object.keys(all).filter(item => item.startsWith(prefix) && item !== key)
          .sort((a, b) => all[b]?.fetchedAt - all[a]?.fetchedAt);
        const remove = [];
        let count = 1;
        for (const item of keys) {
          const entryBytes = size(item, all[item]);
          if (count >= 500 || bytes + entryBytes > maxBytes) remove.push(item);
          else { bytes += entryBytes; count++; }
        }
        if (remove.length) await this.storage.remove(remove);
        await this.storage.set({ [key]: entry });
        return true;
      });
    }
    clear() {
      this.generation++;
      return this.mutate(async () => {
        const all = await this.storage.get(null);
        await this.storage.remove(Object.keys(all).filter(key => key.startsWith(prefix)));
        await this.storage.set({ cacheClearedAt: this.now() });
      });
    }
  }
  Sublore.ActivityCache = ActivityCache;
})();
