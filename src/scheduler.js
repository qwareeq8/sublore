"use strict";
(() => {
  class RequestScheduler {
    constructor({ storage, interval = () => 1000, now = Date.now,
      sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
      Object.assign(this, { storage, interval, now, sleep });
      this.pending = new Map();
      this.tail = Promise.resolve();
      this.ready = storage.get("scheduler").then(({ scheduler }) => {
        this.nextAt = Number.isFinite(scheduler?.nextAt) ? scheduler.nextAt : 0;
        this.cooldownAt = Number.isFinite(scheduler?.cooldownAt) ? scheduler.cooldownAt : 0;
      });
    }
    save() { return this.storage.set({ scheduler: { nextAt: this.nextAt, cooldownAt: this.cooldownAt } }); }
    run(key, task, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(new Sublore.ApiError("Lookup canceled."));
      const existing = this.pending.get(key);
      if (existing) {
        this.subscribe(existing, signal);
        return existing.promise;
      }
      if (this.pending.size >= 50) return Promise.reject(new Sublore.ApiError("The lookup queue is full. Try again shortly."));
      const job = { controller: new AbortController(), signals: new Set(), listeners: [], queuedAt: this.now() };
      const check = () => {
        if (job.controller.signal.aborted) throw new Sublore.ApiError("Lookup canceled.");
        if (this.now() - job.queuedAt > 120000) throw new Sublore.ApiError("The lookup queue took too long. Try again.");
      };
      const work = this.tail.then(async () => {
        await this.ready;
        for (let attempt = 0; attempt < 3; attempt++) {
          check();
          if (this.cooldownAt > this.now()) throw new Sublore.ApiError("Arctic Shift is cooling down. Try again later.", { retryAt: this.cooldownAt });
          while (this.nextAt > this.now()) {
            await this.sleep(Math.min(1000, this.nextAt - this.now()));
            check();
          }
          this.nextAt = this.now() + this.interval();
          await this.save();
          try { return await task(job.controller.signal); } catch (error) {
            if (error.retryAt > this.now()) {
              this.cooldownAt = error.retryAt;
              await this.save();
              throw error;
            }
            check();
            if (!error.retryable || attempt === 2) throw error;
            this.nextAt = Math.max(this.nextAt, this.now() + 2000 * 2 ** attempt);
            await this.save();
          }
        }
      });
      job.promise = work;
      job.cancel = () => {
        if (!job.unconditional && [...job.signals].every(item => item.aborted)) {
          job.controller.abort();
          if (this.pending.get(key) === job) this.pending.delete(key);
        }
      };
      this.pending.set(key, job);
      this.subscribe(job, signal);
      this.tail = work.catch(() => {});
      work.finally(() => {
        if (this.pending.get(key) === job) this.pending.delete(key);
        for (const [item, listener] of job.listeners) item.removeEventListener("abort", listener);
      }).catch(() => {});
      return work;
    }
    subscribe(job, signal) {
      if (!signal) { job.unconditional = true; return; }
      job.signals.add(signal);
      signal.addEventListener("abort", job.cancel, { once: true });
      job.listeners.push([signal, job.cancel]);
    }
  }
  Sublore.RequestScheduler = RequestScheduler;
})();
