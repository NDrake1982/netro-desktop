# NetroDesktop

A browser-based dashboard for [Netro](https://www.netrohome.com/) smart sprinkler controllers,
with the cross-controller view the Netro app doesn't have — useful when multiple controllers
share a single water source (e.g. one borehole).

**Pure static site** — no backend, no install. Your serial numbers stay in your browser's
local storage and are sent only to `api.netrohome.com` when fetching device data.

## Features

- Unified dashboard for any number of controllers
- Per-zone manual run, controller-wide stop, skip-day, enable/disable
- Nicknames per controller (display-only)
- _Coming next:_ unified timeline view + borehole-capacity conflict detection

## Use it

Hosted: see your Pages URL after enabling GitHub Pages on this repo.

To run locally instead, just open `index.html` in any modern browser
(Chrome, Edge, Firefox). Because it uses ES modules, browsers won't load it
via `file://` — start any tiny static server in this folder, e.g.:

```
python -m http.server 8000
```
…then visit http://127.0.0.1:8000.

## Setup

1. Find each controller's serial number in the Netro mobile app
   (Settings → look for "Serial number"). 12-char hex string.
2. Open this page, go to **Settings** tab.
3. Click **+ Add controller**, paste serial, give it a nickname, hit **Save**.

## Privacy

- Your serial numbers live only in this browser's `localStorage`.
- They're sent directly from your browser to `https://api.netrohome.com/` — no
  intermediate server.
- This page is public, but it can't see anyone's serials without you typing them in.
- Use the same URL on another device by re-entering serials there (or sync via your
  password manager / a note).
