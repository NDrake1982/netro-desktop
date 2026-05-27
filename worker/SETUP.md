# Cloudflare Worker setup

This walks you through deploying the Worker that handles **automatic recurring
schedules** with borehole-aware staggering. Once set up, it runs every day on
Cloudflare's servers — even when your PC is off — and pushes the day's
waterings to Netro at the right times.

Total time: **~10 minutes**, all in the browser. Free forever within Cloudflare's
free tier limits (which are ~100× more than this app will ever use).

---

## 1. Create a free Cloudflare account

1. Go to **https://dash.cloudflare.com/sign-up**
2. Sign up with email + password. Verify your email.
3. You'll land on the dashboard. Skip the "Add a website" prompt — you don't need to.

## 2. Create the KV namespace (the Worker's storage)

The Worker needs a tiny key-value store to hold your config (controllers,
patterns, borehole capacity).

1. Left sidebar: **Storage & Databases** → **KV**
2. Click **Create a namespace**
3. Name it `netro-config` (any name works, but match this for clarity)
4. Click **Add**

Leave this tab open — we'll come back to it.

## 3. Create the Worker

1. Left sidebar: **Workers & Pages** → **Create**
2. Pick **Start with Hello World!** → click **Get started**
3. Service name: `netro-desktop-worker` (or anything you like — this becomes part of the URL)
4. Click **Deploy** (you'll deploy the placeholder first, then replace the code)
5. After deploy, click **Edit code** (top-right)

## 4. Paste the Worker code

1. In Cloudflare's online editor, **select all** the existing `worker.js` content and delete it
2. Open this file from the GitHub repo in another tab: **https://github.com/NDrake1982/netro-desktop/blob/main/worker/worker.js**
3. Click the **Raw** button → **Ctrl+A** → **Ctrl+C** → back to Cloudflare → **Ctrl+V**
4. Click **Save and deploy** (top-right) → confirm

## 5. Bind the KV namespace to the Worker

The Worker needs to know *which* KV namespace to use.

1. Top tab in the Worker view: **Settings**
2. **Bindings** section → **Add** → **KV Namespace**
3. **Variable name:** `CONFIG` (must be exactly this — the code looks for `env.CONFIG`)
4. **KV namespace:** select `netro-config`
5. Click **Save and deploy**

## 6. Set the auth token (secret)

This token is what the dashboard uses to authenticate when reading/writing config.
Anyone with this token can change your patterns and run waterings, so treat it
like a password.

1. Same **Settings** tab → **Variables and Secrets**
2. Click **Add** → **Secret**
3. **Name:** `AUTH_TOKEN` (exactly this)
4. **Value:** make up a strong password. Easiest: open a terminal and run
   `openssl rand -hex 16` (or just hammer the keyboard for 30+ random chars).
   **Save this somewhere safe** — you'll paste it into the dashboard in a moment.
5. Click **Save and deploy**

## 7. Set the cron trigger (when it runs each day)

1. Same **Settings** tab → **Triggers** → **Cron Triggers**
2. Click **Add Cron Trigger**
3. Cron expression: `0 3 * * *` (this means "3:00 UTC every day" — that's 4am BST in summer, 3am GMT in winter, giving the Worker plenty of time before normal watering hours)
4. Click **Add Trigger**

## 8. Grab your Worker URL

Top of the Worker page, you'll see a URL like:
`https://netro-desktop-worker.YOURUSERNAME.workers.dev`

Copy it.

## 9. Connect from the dashboard

1. Open **https://ndrake1982.github.io/netro-desktop/**
2. Click the **Automation** tab
3. Paste your Worker URL and the auth token
4. Click **Connect**

The dashboard will verify it can reach the Worker and load any existing config.
Then you can:
- Click **Sync from this device** to push your local controllers + borehole capacity to the Worker
- Add recurring patterns (one per zone + day-of-week + preferred time + duration)
- Click **Save**
- Click **Run today's schedule now** to test (the Worker will queue waterings immediately rather than waiting for tomorrow's cron)

That's it — from this point on, the Worker runs daily at 3am UTC and queues
the day's waterings into Netro, respecting your borehole capacity. You can
close every browser tab and it keeps running.

---

## Troubleshooting

- **`/status` returns `has_token: false`** — the AUTH_TOKEN secret isn't set. Re-do step 6.
- **Connect fails with "unauthorized"** — the token you pasted into the dashboard doesn't match the one set on the Worker. Re-set the secret and re-enter in the dashboard.
- **Connect fails with network error** — wrong URL, or worker isn't deployed yet. Check the URL in the Cloudflare dashboard.
- **No waterings happening after cron time** — open Cloudflare → your worker → **Logs** tab → look for the `cron:` line. If it ran but `placed: 0`, no patterns matched today's day-of-week.
- **Want to pause everything?** Cloudflare → Worker → Settings → Triggers → toggle the cron off. Patterns stay saved.
