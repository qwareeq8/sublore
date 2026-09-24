"use strict";
(() => {
  const containers = 'shreddit-comment, .thing.comment, [data-testid="comment"]';
  function profileName(link) {
    try {
      const url = new URL(link.getAttribute("href"), location.href);
      if (url.protocol !== "https:" || !/(^|\.)reddit\.com$/i.test(url.hostname)) return null;
      const match = url.pathname.match(/^\/(?:user|u)\/([^/]+)\/?$/i);
      return match ? Sublore.username(decodeURIComponent(match[1])) : null;
    } catch { return null; }
  }
  function authorLink(container) {
    let expected = container.getAttribute("author") || container.getAttribute("data-author");
    if (expected) {
      try { expected = Sublore.username(expected); } catch { return null; }
    }
    const links = container.querySelectorAll('a[href*="/user/"], a[href*="/u/"]');
    for (const link of links) {
      if (link.closest(containers) !== container || link.closest('[slot="comment"], .md, [data-testid="comment-content"]')) continue;
      const name = profileName(link);
      if (!name || (expected && name !== expected)) continue;
      const header = link.closest('[slot="commentMeta"], .tagline, [data-testid="comment_author_link"], [data-testid="comment-author"], [noun="comment_author"]');
      if (header && link.textContent.trim()) return { link, author: name };
    }
    return null;
  }
  function discover(root) {
    const found = [];
    const comments = new Set(root.querySelectorAll?.(containers) || []);
    if (root.matches?.(containers)) comments.add(root);
    const parent = root.closest?.(containers);
    if (parent) comments.add(parent);
    for (const comment of comments) {
      const result = authorLink(comment);
      if (result) found.push(result);
    }
    return found;
  }
  function isThread() { return /\/comments\/[a-z0-9]+(?:\/|$)/i.test(location.pathname); }
  function currentSubreddit() { return location.pathname.match(/^\/r\/([a-z0-9_]{2,21})\//i)?.[1] || null; }
  Object.assign(Sublore, { discover, profileName, isThread, currentSubreddit });
})();
