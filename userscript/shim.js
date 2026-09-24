"use strict";
// Implements the extension APIs used by src/ on top of userscript-manager grants.
// The background and content scripts share one page context in the userscript build.
const browser = (() => {
  const id = "sublore-userscript";
  const optionsUrl = `userscript:${id}/options/options.html`;
  const storageListeners = [];
  const messageListeners = [];
  const connectListeners = [];
  const notify = changes => {
    if (!Object.keys(changes).length) return;
    setTimeout(() => { for (const listener of storageListeners) listener(changes, "local"); }, 0);
  };
  const keysOf = keys => keys === null || keys === undefined ? GM_listValues()
    : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const local = {
    async get(keys) {
      const result = {};
      for (const key of keysOf(keys)) {
        const value = GM_getValue(key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        GM_setValue(key, value);
        changes[key] = { newValue: value };
      }
      notify(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of keysOf(keys)) {
        changes[key] = { oldValue: GM_getValue(key) };
        GM_deleteValue(key);
      }
      notify(changes);
    },
  };
  // Other tabs only need to hear about settings and cache clears.
  if (typeof GM_addValueChangeListener === "function") {
    for (const key of ["settings", "cacheClearedAt"]) {
      GM_addValueChangeListener(key, (name, oldValue, newValue, remote) => {
        if (remote) notify({ [name]: { oldValue, newValue } });
      });
    }
  }
  function port(name) {
    const self = { name, message: [], disconnect: [], closed: false };
    self.api = {
      name,
      onMessage: { addListener: listener => self.message.push(listener) },
      onDisconnect: { addListener: listener => self.disconnect.push(listener) },
      postMessage(message) {
        if (self.closed) throw new Error("Attempting to use a disconnected port object.");
        const copy = structuredClone(message);
        setTimeout(() => { if (!self.peer.closed) for (const listener of self.peer.message) listener(copy); }, 0);
      },
      disconnect() {
        if (self.closed) return;
        self.closed = self.peer.closed = true;
        setTimeout(() => { for (const listener of self.peer.disconnect) listener(); }, 0);
      },
    };
    return self;
  }
  const runtime = {
    id,
    getURL: path => `userscript:${id}/${path}`,
    onMessage: { addListener: listener => messageListeners.push(listener) },
    onConnect: { addListener: listener => connectListeners.push(listener) },
    sendMessage(message) {
      return new Promise(resolve => {
        const copy = structuredClone(message);
        for (const listener of messageListeners) listener(copy, { id, url: optionsUrl }, response => resolve(structuredClone(response)));
      });
    },
    connect({ name } = {}) {
      const a = port(name), b = port(name);
      a.peer = b; b.peer = a;
      b.api.sender = { id };
      setTimeout(() => { for (const listener of connectListeners) listener(b.api); }, 0);
      return a.api;
    },
    openOptionsPage: () => openOptionsPanel(),
  };
  const action = { onClicked: { addListener: listener => GM_registerMenuCommand("Settings", listener) } };
  return { storage: { local, onChanged: { addListener: listener => storageListeners.push(listener) } }, runtime, action };
})();

// Page fetches to Arctic Shift can be blocked by Reddit's CSP, so requests go through the manager.
function fetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) { reject(new DOMException("The request was aborted.", "AbortError")); return; }
    const request = GM_xmlhttpRequest({
      method: "GET", url, anonymous: true, responseType: "text",
      onload(response) {
        const headers = new Headers();
        for (const line of (response.responseHeaders || "").split(/\r?\n/)) {
          const index = line.indexOf(":");
          if (index > 0) { try { headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim()); } catch { /* Skip malformed headers. */ } }
        }
        resolve(new Response(response.responseText, { status: response.status, headers }));
      },
      onerror: () => reject(new TypeError("Network request failed.")),
      ontimeout: () => reject(new TypeError("Network request timed out.")),
      onabort: () => reject(new DOMException("The request was aborted.", "AbortError")),
    });
    init.signal?.addEventListener("abort", () => { request?.abort?.(); reject(new DOMException("The request was aborted.", "AbortError")); }, { once: true });
  });
}

function addStyle(parent, css) {
  if (typeof GM_addElement === "function") return GM_addElement(parent, "style", { textContent: css });
  const style = document.createElement("style");
  style.textContent = css;
  parent.append(style);
  return style;
}

// OPTIONS_TREE is options.html converted at build time; this avoids innerHTML under Trusted Types.
function build(node) {
  if (typeof node === "string") return document.createTextNode(node);
  const [tag, attributes, children] = node;
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  for (const child of children) element.append(build(child));
  return element;
}

function openOptionsPanel() {
  if (document.getElementById("sublore-options-host")) return;
  const host = document.createElement("div");
  host.id = "sublore-options-host";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  addStyle(root, OPTIONS_CSS);
  const page = document.createElement("div");
  page.className = "sublore-page";
  page.setAttribute("role", "dialog");
  page.setAttribute("aria-modal", "true");
  page.setAttribute("aria-label", "Sublore settings");
  for (const node of OPTIONS_TREE) page.append(build(node));
  root.append(page);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sublore-close";
  close.textContent = "Close";
  const previous = document.activeElement;
  const dismiss = () => { host.remove(); document.removeEventListener("keydown", onKey, true); previous?.focus?.(); };
  const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } };
  close.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKey, true);
  page.querySelector(".page-header").append(close);
  document.body.append(host);
  runOptions({ getElementById: name => root.getElementById(name), createElement: tag => document.createElement(tag) });
  close.focus();
}
