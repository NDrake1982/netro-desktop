// NetroDesktop Cloudflare Worker
// =================================
// Cron + tiny HTTP API. Runs in Cloudflare's serverless network, no machine of yours required.
//
// Every day at the cron time it:
//   1. Reads its config from KV (controllers, borehole capacity, recurring patterns)
//   2. Figures out which patterns should run today (based on day-of-week)
//   3. Staggers them so the combined flow never exceeds your borehole capacity
//   4. Pushes each watering to Netro via /water.json with the staggered start_time
//
// The dashboard (GitHub Pages site) calls /config and /run-now to manage things.
//
// See SETUP.md in this folder for deployment steps.

const VERSION = '0.5.0';
const NETRO_BASE = 'https://api.netrohome.com/npa/v1';

export default {
    async fetch(request, env) {
        return handleHttp(request, env);
    },
    async scheduled(event, env, ctx) {
        // Two cron triggers fire this handler:
        //   "0 3 * * *"   → daily recurring-pattern push (long-running stagger)
        //   "*/15 * * * *" → sensor-trigger rule evaluation (short, idempotent w/ cooldown)
        const cron = event.cron || '';
        if (cron.startsWith('*/15') || cron.startsWith('*/5') || cron.startsWith('*/10')) {
            ctx.waitUntil((async () => {
                const resumed = await resumeExpiredPauses(env);
                const rules = await evaluateSensorRules(env);
                console.log('tick:', JSON.stringify({ resumed, rules }));
            })());
        } else {
            ctx.waitUntil(
                runDailyCron(env).then(r => console.log('cron:', JSON.stringify(r)))
            );
        }
    },
};

// ---------- HTTP API ----------

async function handleHttp(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // Public health check — used by the dashboard to verify the URL before asking for the token.
    if (url.pathname === '/status' && request.method === 'GET') {
        return cors(json({
            ok: true,
            version: VERSION,
            now: new Date().toISOString(),
            has_token: !!env.AUTH_TOKEN,
        }));
    }

    // Everything else requires the Bearer token.
    const auth = request.headers.get('Authorization');
    if (!env.AUTH_TOKEN || auth !== `Bearer ${env.AUTH_TOKEN}`) {
        return cors(json({ error: 'unauthorized' }, 401));
    }

    if (url.pathname === '/config') {
        if (request.method === 'GET') {
            return cors(json(await loadConfig(env)));
        }
        if (request.method === 'POST') {
            const body = await request.json();
            await saveConfig(env, body);
            return cors(json({ ok: true }));
        }
    }

    if (url.pathname === '/run-now' && request.method === 'POST') {
        const result = await runDailyCron(env);
        return cors(json(result));
    }

    if (url.pathname === '/evaluate-rules-now' && request.method === 'POST') {
        const result = await evaluateSensorRules(env);
        return cors(json(result));
    }

    if (url.pathname === '/watering-log' && request.method === 'GET') {
        const log = await loadWateringLog(env);
        return cors(json(log));
    }

    if (url.pathname === '/pause' && request.method === 'POST') {
        const { serial, until } = await request.json();
        const result = await pauseController(env, serial, until);
        return cors(json(result));
    }

    if (url.pathname === '/resume' && request.method === 'POST') {
        const { serial } = await request.json();
        const result = await resumeController(env, serial);
        return cors(json(result));
    }

    return cors(json({ error: 'not found' }, 404));
}

// ---------- Pause / resume ----------

const SNAPSHOT_KEY = (serial) => `paused_snapshot_${serial}`;

async function pauseController(env, serial, untilIso) {
    const cfg = await loadConfig(env);
    const ctrl = cfg.controllers.find(c => c.serial === serial);
    if (!ctrl) return { ok: false, error: 'controller not found in worker config' };

    const now = new Date();
    const until = new Date(untilIso);

    // Snapshot schedules that would have run during the pause window so we
    // can replay them after the pause expires.
    let snapshotCount = 0;
    try {
        const window = await fetchValidSchedulesInWindow(serial, now, until);
        await env.CONFIG.put(SNAPSHOT_KEY(serial), JSON.stringify(window));
        snapshotCount = window.length;
    } catch (e) {
        // If snapshot fails, pause still proceeds but warn
        console.log(`snapshot failed for ${serial}: ${e.message}`);
    }

    ctrl.paused_until = untilIso;
    await saveConfig(env, cfg);

    try {
        await netroSetStatus(serial, false);
    } catch (e) {
        return { ok: true, warn: `paused in config but Netro disable failed: ${e.message}`, snapshot: snapshotCount };
    }
    return { ok: true, paused_until: untilIso, snapshot: snapshotCount };
}

async function resumeController(env, serial) {
    const cfg = await loadConfig(env);
    const ctrl = cfg.controllers.find(c => c.serial === serial);
    if (!ctrl) return { ok: false, error: 'controller not found' };
    ctrl.paused_until = null;
    await saveConfig(env, cfg);

    let replayed = 0;
    try {
        await netroSetStatus(serial, true);
        // Small delay so Netro has time to register the enable before we queue waters
        replayed = await replayMissedSchedules(env, serial);
    } catch (e) {
        return { ok: true, warn: `resumed in config but Netro enable failed: ${e.message}` };
    }
    return { ok: true, replayed };
}

async function resumeExpiredPauses(env) {
    const cfg = await loadConfig(env);
    const now = Date.now();
    const resumed = [];
    let dirty = false;
    for (const ctrl of cfg.controllers || []) {
        if (!ctrl.paused_until) continue;
        if (new Date(ctrl.paused_until).getTime() > now) continue;
        ctrl.paused_until = null;
        dirty = true;
        try {
            await netroSetStatus(ctrl.serial, true);
            const replayed = await replayMissedSchedules(env, ctrl.serial);
            resumed.push({ serial: ctrl.serial, replayed });
        } catch (e) {
            resumed.push({ serial: ctrl.serial, warn: e.message });
        }
    }
    if (dirty) await saveConfig(env, cfg);
    return { resumed };
}

// Read upcoming VALID schedules from Netro that overlap a given window.
async function fetchValidSchedulesInWindow(serial, fromDate, toDate) {
    const startStr = toIsoDate(fromDate);
    const endStr = toIsoDate(toDate);
    const params = new URLSearchParams({ key: serial, start_date: startStr, end_date: endStr });
    const r = await fetch(`${NETRO_BASE}/schedules.json?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.status !== 'OK') throw new Error(`Netro: ${(j.errors?.[0]?.message) || j.status}`);
    const scheds = j.data?.schedules || [];
    const fromMs = fromDate.getTime();
    const toMs = toDate.getTime();
    return scheds
        .filter(s => s.status === 'VALID')
        .filter(s => {
            const st = parseTime(s.start_time);
            return st >= fromMs && st < toMs;
        })
        .map(s => ({
            zone: s.zone,
            duration_min: Math.max(1, Math.round((parseTime(s.end_time) - parseTime(s.start_time)) / 60_000)),
            original_start: s.start_time,
        }));
}

// Replay missed schedules from the pause snapshot. Queues them back-to-back
// starting one minute from now so they all run sequentially.
async function replayMissedSchedules(env, serial) {
    const raw = await env.CONFIG.get(SNAPSHOT_KEY(serial));
    if (!raw) return 0;
    let snapshot;
    try { snapshot = JSON.parse(raw); } catch { snapshot = []; }
    await env.CONFIG.delete(SNAPSHOT_KEY(serial));
    if (!snapshot.length) return 0;

    // Order by original_start to keep the original sequence intact.
    snapshot.sort((a, b) => parseTime(a.original_start) - parseTime(b.original_start));

    let cursorMs = Date.now() + 60_000; // first replay starts ~1 min from resume
    let pushed = 0;
    for (const s of snapshot) {
        const startIso = new Date(cursorMs).toISOString().replace(/\.\d+Z$/, 'Z');
        try {
            await netroWater(serial, [s.zone], s.duration_min, startIso);
            await appendWateringLog(env, {
                origin: 'pause-replay',
                serial,
                zone: s.zone,
                start_time: startIso,
                duration_min: s.duration_min,
                original_start: s.original_start,
            });
            pushed++;
            cursorMs += s.duration_min * 60_000;
        } catch (e) {
            console.log(`replay failed for ${serial} z${s.zone}: ${e.message}`);
        }
    }
    return pushed;
}

function isPaused(ctrl, now = new Date()) {
    if (!ctrl?.paused_until) return false;
    return new Date(ctrl.paused_until).getTime() > now.getTime();
}

async function netroSetStatus(serial, enabled) {
    const r = await fetch(`${NETRO_BASE}/set_status.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: serial, status: enabled ? 1 : 0 }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.status !== 'OK') throw new Error(`Netro: ${(j.errors?.[0]?.message) || j.status}`);
}

// Watering log — every netroWater call the Worker makes gets a row so the
// dashboard can distinguish "sensor rule" runs from "daily cron" runs from
// dashboard-button manual runs (which never touch the Worker).
const WATERING_LOG_KEY = 'watering_log';
const WATERING_LOG_MAX = 500;

async function loadWateringLog(env) {
    const raw = await env.CONFIG.get(WATERING_LOG_KEY);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
}

async function appendWateringLog(env, entry) {
    const log = await loadWateringLog(env);
    log.push({ ...entry, logged_at: new Date().toISOString() });
    if (log.length > WATERING_LOG_MAX) log.splice(0, log.length - WATERING_LOG_MAX);
    await env.CONFIG.put(WATERING_LOG_KEY, JSON.stringify(log));
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function cors(resp) {
    resp.headers.set('Access-Control-Allow-Origin', '*');
    resp.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    resp.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return resp;
}

// ---------- Config (Workers KV) ----------

async function loadConfig(env) {
    const raw = await env.CONFIG.get('config');
    return raw ? { ...defaultConfig(), ...JSON.parse(raw) } : defaultConfig();
}

async function saveConfig(env, cfg) {
    await env.CONFIG.put('config', JSON.stringify(cfg));
}

function defaultConfig() {
    return {
        borehole_capacity_lpm: 20,
        default_zone_flow_lpm: null, // null → use borehole capacity as zone flow (conservative)
        controllers: [],             // [{ serial, nickname }]
        sensors: [],                 // [{ serial, nickname, rules: [] }]
        patterns: [],                // see below for shape
        last_run: null,
        last_sensor_eval: null,
    };
}

// Pattern shape:
// {
//   id: "<uuid-ish>",
//   enabled: true,
//   controller_serial: "5443b28f1a44",
//   zone: 1,                          // zone index (ith)
//   days: [1, 3, 5],                  // 0=Sun ... 6=Sat (UTC)
//   preferred_time_utc: "05:30",      // 24h UTC
//   duration_min: 15,
//   note: "Front Grass"
// }

// ---------- Daily cron ----------

async function runDailyCron(env) {
    const cfg = await loadConfig(env);
    const now = new Date();
    const todayDow = now.getUTCDay();

    const todays = (cfg.patterns || []).filter(p => p.enabled && Array.isArray(p.days) && p.days.includes(todayDow));

    if (!todays.length) {
        const result = { ts: now.toISOString(), placed: 0, message: 'no patterns for today' };
        cfg.last_run = result;
        await saveConfig(env, cfg);
        return result;
    }

    const placements = stagger(
        todays,
        cfg.borehole_capacity_lpm || 20,
        cfg.default_zone_flow_lpm || cfg.borehole_capacity_lpm || 20,
        now
    );

    const pushed = [];
    const failed = [];
    const skipped = [];
    for (const p of placements) {
        // Don't push patterns to controllers that are still in a pause window.
        const ctrlCfg = cfg.controllers.find(c => c.serial === p.serial);
        if (isPaused(ctrlCfg, now)) {
            skipped.push({ serial: p.serial, zone: p.zone, reason: 'paused' });
            continue;
        }
        try {
            await netroWater(p.serial, [p.zone], p.duration_min, p.start_time_iso);
            pushed.push({ serial: p.serial, zone: p.zone, start: p.start_time_iso, duration: p.duration_min });
            await appendWateringLog(env, {
                origin: 'daily-cron',
                serial: p.serial,
                zone: p.zone,
                start_time: p.start_time_iso,
                duration_min: p.duration_min,
                pattern_id: p.id || null,
            });
        } catch (e) {
            failed.push({ serial: p.serial, zone: p.zone, error: e.message });
        }
    }

    const result = { ts: now.toISOString(), placed: pushed.length, failed: failed.length, skipped: skipped.length, pushed, failed, skipped_list: skipped };
    cfg.last_run = result;
    await saveConfig(env, cfg);
    return result;
}

// Pack today's patterns into the day so total simultaneous flow never exceeds capacity.
// Greedy: try preferred time first; if it doesn't fit, push to the next moment something else ends.
function stagger(patterns, capacityLpm, zoneFlowLpm, now) {
    const flow = zoneFlowLpm;
    const cap = capacityLpm;

    const sorted = patterns
        .map(p => ({
            ...p,
            preferredMs: timeToUtcMsToday(now, p.preferred_time_utc),
            durationMs: Math.max(1, (p.duration_min || 10)) * 60 * 1000,
        }))
        .sort((a, b) => a.preferredMs - b.preferredMs);

    const placed = []; // { startMs, endMs, flow, ...pattern }
    const SAFETY = 1000;

    for (const p of sorted) {
        let startMs = p.preferredMs;
        // If start is already in the past (cron ran late / preferred time earlier than now), bump.
        if (startMs < now.getTime() + 60_000) startMs = now.getTime() + 60_000;

        for (let iter = 0; iter < SAFETY; iter++) {
            const endMs = startMs + p.durationMs;
            const peak = peakOverlap(placed, startMs, endMs);
            if (peak + flow <= cap + 0.0001) {
                placed.push({ ...p, startMs, endMs, flow });
                break;
            }
            // Doesn't fit. Push start to the next moment an existing placement ends.
            const candidates = placed
                .filter(q => q.endMs > startMs && q.startMs < endMs)
                .map(q => q.endMs)
                .filter(t => t > startMs);
            startMs = candidates.length ? Math.min(...candidates) : (startMs + 60_000);
        }
    }

    return placed.map(p => ({
        serial: p.controller_serial,
        zone: p.zone,
        duration_min: p.duration_min,
        start_time_iso: new Date(p.startMs).toISOString().replace(/\.\d+Z$/, 'Z'),
    }));
}

function peakOverlap(placed, startMs, endMs) {
    const events = [];
    for (const q of placed) {
        if (q.endMs <= startMs || q.startMs >= endMs) continue;
        events.push({ t: Math.max(q.startMs, startMs), d: +q.flow });
        events.push({ t: Math.min(q.endMs, endMs),     d: -q.flow });
    }
    events.sort((a, b) => a.t - b.t || a.d - b.d);
    let cur = 0, peak = 0;
    for (const e of events) { cur += e.d; if (cur > peak) peak = cur; }
    return peak;
}

function timeToUtcMsToday(now, hhmm) {
    const [h, m] = (hhmm || '06:00').split(':').map(Number);
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h || 0, m || 0, 0);
}

// ---------- Sensor-triggered irrigation ----------
// Each sensor can carry an array `rules` of objects:
// {
//   id, enabled,
//   metric: 'moisture' | 'celsius' | 'sunlight',
//   comparator: '<' | '>',
//   threshold: number,
//   action: { controller_serial, zone, duration_min },
//   cooldown_hours: number,
//   last_triggered_at: ISO string | null
// }
async function evaluateSensorRules(env) {
    const cfg = await loadConfig(env);
    const now = new Date();
    const sensors = (cfg.sensors || []).filter(s => Array.isArray(s.rules) && s.rules.some(r => r.enabled !== false));
    if (!sensors.length) {
        return { ts: now.toISOString(), checked: 0, triggered: 0, message: 'no sensors with rules' };
    }

    const triggered = [];
    const failed = [];
    let configDirty = false;

    for (const sensor of sensors) {
        let latest;
        try {
            latest = await fetchLatestSensorReading(sensor.serial);
        } catch (e) {
            failed.push({ serial: sensor.serial, error: `reading fetch: ${e.message}` });
            continue;
        }
        if (!latest) continue;

        for (const rule of sensor.rules) {
            if (rule.enabled === false) continue;
            const value = latest[rule.metric];
            if (value == null) continue;
            const matched = rule.comparator === '>' ? value > rule.threshold : value < rule.threshold;
            if (!matched) continue;

            // Cooldown check
            if (rule.last_triggered_at && rule.cooldown_hours) {
                const lastMs = new Date(rule.last_triggered_at).getTime();
                const ageHrs = (now.getTime() - lastMs) / 3_600_000;
                if (ageHrs < rule.cooldown_hours) continue;
            }

            // Normalize zones (backwards compat with old single-zone schema).
            const zones = Array.isArray(rule.action.zones) && rule.action.zones.length
                ? rule.action.zones
                : (rule.action.zone ? [rule.action.zone] : []);
            if (!zones.length) {
                failed.push({ sensor: sensor.serial, rule: rule.id, error: 'rule has no zones selected' });
                continue;
            }

            // Skip if controller is paused (its pause window hasn't expired yet).
            const ctrlCfg = cfg.controllers.find(c => c.serial === rule.action.controller_serial);
            if (isPaused(ctrlCfg, now)) continue;

            // Skip if the rule's controller already has something running — avoid clashing with an active program.
            try {
                const isBusy = await isControllerRunning(rule.action.controller_serial, now);
                if (isBusy) continue;
            } catch (e) {
                // If the check itself fails, fail safe by skipping rather than firing.
                failed.push({ sensor: sensor.serial, rule: rule.id, error: `busy-check: ${e.message}` });
                continue;
            }

            // Stack zones sequentially:
            //   zone[0] → no start_time, so Netro waters IMMEDIATELY
            //   zone[1+] → start_time set to end-of-previous-zone, queued by Netro
            // Sending start_time=now for zone[0] would let Netro bump it to the
            // next hour slot (their docs require start_time strictly in the future).
            const durationMin = rule.action.duration_min || 10;
            const queued = [];
            const stackFailures = [];
            for (let zi = 0; zi < zones.length; zi++) {
                let startIso = null;
                if (zi > 0) {
                    const startMs = now.getTime() + zi * durationMin * 60_000;
                    startIso = new Date(startMs).toISOString().replace(/\.\d+Z$/, 'Z');
                }
                try {
                    await netroWater(rule.action.controller_serial, [zones[zi]], durationMin, startIso);
                    queued.push({ zone: zones[zi], start: startIso || 'immediate' });
                    await appendWateringLog(env, {
                        origin: 'sensor-rule',
                        serial: rule.action.controller_serial,
                        zone: zones[zi],
                        start_time: startIso,
                        duration_min: durationMin,
                        sensor_serial: sensor.serial,
                        rule_id: rule.id,
                        metric: rule.metric,
                        reading_value: value,
                    });
                } catch (e) {
                    stackFailures.push({ zone: zones[zi], error: e.message });
                }
            }

            if (queued.length) {
                rule.last_triggered_at = now.toISOString();
                configDirty = true;
                triggered.push({
                    sensor: sensor.serial,
                    metric: rule.metric,
                    value,
                    threshold: rule.threshold,
                    controller: rule.action.controller_serial,
                    queued,
                });
            }
            if (stackFailures.length) {
                failed.push({ sensor: sensor.serial, rule: rule.id, stackFailures });
            }
        }
    }

    if (configDirty) await saveConfig(env, cfg);

    const result = {
        ts: now.toISOString(),
        checked: sensors.length,
        triggered: triggered.length,
        failed: failed.length,
        triggered_list: triggered,
        failed_list: failed,
    };
    // Stash on config for visibility from dashboard.
    cfg.last_sensor_eval = result;
    await saveConfig(env, cfg);
    return result;
}

// Returns true if any schedule on the given controller is currently EXECUTING.
async function isControllerRunning(serial, now) {
    const today = toIsoDate(now);
    const params = new URLSearchParams({ key: serial, start_date: today, end_date: today });
    const r = await fetch(`${NETRO_BASE}/schedules.json?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.status !== 'OK') throw new Error(`Netro: ${(j.errors?.[0]?.message) || j.status}`);
    const scheds = j.data?.schedules || [];
    const nowMs = now.getTime();
    for (const s of scheds) {
        if (s.status !== 'EXECUTING') continue;
        const st = parseTime(s.start_time);
        const en = parseTime(s.end_time);
        if (st <= nowMs && en > nowMs) return true;
    }
    return false;
}

async function fetchLatestSensorReading(serial) {
    // Pull the last 1 day of readings and pick the newest.
    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000);
    const params = new URLSearchParams({
        key: serial,
        start_date: toIsoDate(start),
        end_date: toIsoDate(end),
    });
    const r = await fetch(`${NETRO_BASE}/sensor_data.json?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.status !== 'OK') throw new Error(`Netro: ${(j.errors?.[0]?.message) || j.status}`);
    const arr = j.data?.sensor_data || [];
    if (!arr.length) return null;
    return [...arr].sort((a, b) => parseTime(b.time) - parseTime(a.time))[0];
}

function toIsoDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseTime(s) {
    if (!s) return 0;
    return new Date(s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z').getTime();
}

// ---------- Netro API ----------

async function netroWater(serial, zones, duration_min, start_time) {
    const body = { key: serial, zones, duration: duration_min };
    if (start_time) body.start_time = start_time;
    const r = await fetch(`${NETRO_BASE}/water.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.status !== 'OK') throw new Error(`Netro: ${(j.errors?.[0]?.message) || j.status}`);
}
