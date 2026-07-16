// Config persistence.
// - Primary source of truth: Cloudflare Worker KV (if Worker URL + token are set).
//   That makes config the same on every device.
// - localStorage acts as a cache for fast first-paint + offline fallback.

const STORAGE_KEY = 'netro-desktop-config-v1';
const WORKER_STORE = 'netro-desktop-worker-v1';
const SESSION_STORE = 'netro-desktop-session-v1';

// Default Worker URL — overridable from the login form if you ever rehost.
export const DEFAULT_WORKER_URL = 'https://netro-desktop-worker.nicholas-drake10.workers.dev';

export function defaultConfig() {
    return {
        controllers: [],
        sensors: [],
        borehole_capacity_lpm: null,
        mains_capacity_lpm: null,
        default_zone_flow_lpm: null,
        mains_water_cost_per_m3: 5,
        borehole_started_at: null, // ISO date e.g. "2026-01-15"; powers the "since install" savings window
    };
}

function normalize(cfg) {
    cfg = cfg || {};
    if (!Array.isArray(cfg.controllers)) cfg.controllers = [];
    if (!Array.isArray(cfg.sensors)) cfg.sensors = [];
    // Backwards compat: any controller without a water_source is assumed to be on the borehole.
    cfg.controllers = cfg.controllers.map(c => ({ water_source: 'borehole', ...c }));
    return { ...defaultConfig(), ...cfg };
}

// --- localStorage cache ---

export function loadLocal() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    try { return normalize(JSON.parse(raw)); }
    catch { return defaultConfig(); }
}

export function saveLocal(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

// --- Worker credentials (per-device) ---

export function loadWorkerCreds() {
    // Legacy: URL + token stored under WORKER_STORE. Kept for back-compat.
    const raw = localStorage.getItem(WORKER_STORE);
    let creds = { url: '', token: '' };
    if (raw) { try { creds = JSON.parse(raw); } catch {} }
    // Fallback: if either field is empty, fill in from session/DEFAULT so
    // API calls work as soon as you're logged in — no need to visit Automation tab.
    if (!creds.url) creds.url = DEFAULT_WORKER_URL;
    if (!creds.token) {
        const sess = loadSession();
        if (sess?.token) creds.token = sess.token;
    }
    return creds;
}

export function saveWorkerCreds(creds) {
    localStorage.setItem(WORKER_STORE, JSON.stringify(creds));
}

export function hasWorkerCreds() {
    const c = loadWorkerCreds();
    return !!(c.url && c.token);
}

// --- Session (login) helpers ---

export function loadSession() {
    const raw = localStorage.getItem(SESSION_STORE);
    if (!raw) return null;
    try {
        const s = JSON.parse(raw);
        if (s.expires_at && s.expires_at < Date.now()) {
            localStorage.removeItem(SESSION_STORE);
            return null;
        }
        return s;
    } catch { return null; }
}

export function saveSession(session) {
    localStorage.setItem(SESSION_STORE, JSON.stringify(session));
}

export function clearSession() {
    localStorage.removeItem(SESSION_STORE);
}

export function hasValidSession() {
    return !!loadSession();
}

// --- Cloud (Worker) read/write ---

export async function fetchFromWorker() {
    const c = loadWorkerCreds();
    const r = await fetch(`${c.url}/config`, { headers: { Authorization: `Bearer ${c.token}` } });
    if (!r.ok) throw new Error(`Worker /config → ${r.status}`);
    return r.json();
}

export async function pushToWorker(cfg) {
    const c = loadWorkerCreds();
    const r = await fetch(`${c.url}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
        body: JSON.stringify(cfg),
    });
    if (!r.ok) throw new Error(`Worker save → ${r.status}`);
}

// --- High-level load/save ---
// loadConfig: returns the best available config (cloud if reachable, cache otherwise)
// + a `source` field so the UI can show "synced" vs "offline cache".

export async function loadConfig() {
    const cached = loadLocal();
    if (hasWorkerCreds()) {
        try {
            const cloud = normalize(await fetchFromWorker());
            // First-time migration: if cloud is missing things this device has
            // cached, surface them AND push them up so other devices get them too.
            let needsBackPush = false;
            if (cached.sensors?.length && !cloud.sensors?.length) {
                cloud.sensors = cached.sensors;
                needsBackPush = true;
            }
            if (cached.controllers?.length && !cloud.controllers?.length) {
                cloud.controllers = cached.controllers;
                needsBackPush = true;
            }
            saveLocal(cloud);
            if (needsBackPush) {
                // Fire-and-forget so we don't block first paint.
                pushToWorker(cloud).catch(e => console.warn('migration back-push failed:', e));
            }
            return { cfg: cloud, source: 'cloud' };
        } catch (e) {
            console.warn('Worker unreachable, using cached config:', e);
            return { cfg: cached, source: 'cache' };
        }
    }
    return { cfg: cached, source: 'local' };
}

// saveConfig: writes to localStorage immediately, then to the Worker if creds set.
// Returns whether the cloud write succeeded.
export async function saveConfig(cfg) {
    saveLocal(cfg);
    if (!hasWorkerCreds()) return { cloud: 'none' };
    try {
        // Round-trip merge so we don't clobber fields the dashboard doesn't own
        // (patterns, last_run).
        const existing = await fetchFromWorker().catch(() => ({}));
        const merged = {
            ...existing,
            controllers: cfg.controllers,
            sensors: cfg.sensors,
            borehole_capacity_lpm: cfg.borehole_capacity_lpm,
            default_zone_flow_lpm: cfg.default_zone_flow_lpm,
        };
        await pushToWorker(merged);
        return { cloud: 'ok' };
    } catch (e) {
        return { cloud: 'failed', error: e.message };
    }
}

export function hasController(cfg) {
    return Array.isArray(cfg.controllers) && cfg.controllers.length > 0;
}

export function hasSensor(cfg) {
    return Array.isArray(cfg.sensors) && cfg.sensors.length > 0;
}
