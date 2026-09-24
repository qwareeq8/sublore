# Store listing

Upload `dist/sublore-chrome.zip` to the Chrome Web Store and
`dist/sublore-firefox.zip` to Firefox Add-ons.

## Shared fields

- Name: Sublore
- Summary: Shows how active Reddit commenters are in subreddits you choose,
  right beside their username.
- Category: Social Media & Networking (Chrome); Social & Communication (AMO)
- Homepage: <https://github.com/qwareeq8/sublore>
- Privacy policy: <https://github.com/qwareeq8/sublore/blob/main/PRIVACY.md>
- Chrome store icon (128x128): `assets/icon-128.png`
- Screenshots (1280x800): `screenshot-thread.png`, `screenshot-settings.png`
- Chrome small promo tile (440x280): `promo-small.png`

## Description

```text
Sublore adds a Check button beside each commenter on Reddit comment threads. Click it to see how many posts and comments that person made in each subreddit on your watchlist over the last six months, for example "r/buildapc · 64".

- Choose the subreddits to watch in settings.
- Badges link to that person's comments in that subreddit on the Arctic Shift archive.
- A sprout marks someone whose activity in the current subreddit is all from the last 7 days.
- Results are cached in your browser for 7 days.
- The default watchlist has about 60 political, snark, and gossip subreddits.

Lookups happen only when you click Check. Each lookup sends that username and a date range to Arctic Shift (arctic-shift.photon-reddit.com), a public Reddit archive. Nothing else leaves your browser, and there is no analytics.

Sublore is not affiliated with or endorsed by Reddit, Inc.
```

## Chrome privacy practices

- Single purpose: Shows, on request, how active a Reddit commenter is in
  subreddits the user chooses.
- `storage`: Saves settings, lookup consent, and up to 500 cached lookups.
- Host permission for `arctic-shift.photon-reddit.com`: Fetches a commenter's
  post and comment counts per subreddit from the Arctic Shift archive.
- Content scripts on `reddit.com`: Add the Check button and badges beside
  commenters.
- Remote code: No.
- Data collected: Website content and personally identifiable information,
  both limited to the Reddit username of a commenter the user checks.
- Certify all three Limited Use statements.

## AMO notes to reviewer

```text
No account is needed. Settings open on install; click Allow. Then open any comment thread on www.reddit.com or old.reddit.com and click "Check" beside a username.

The only remote service is the public Arctic Shift API (arctic-shift.photon-reddit.com, https://github.com/ArthurHeitmann/arctic_shift). A request is sent only after the user allows lookups and clicks Check, and contains the Reddit username and a date range, with cookies and referrer omitted. This is declared as websiteContent in data_collection_permissions.

The source is not minified, bundled, or transpiled. The build script scripts/build.cjs copies src/, options/, and assets/ and writes the Firefox manifest; the uploaded files are the source.
```
