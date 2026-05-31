import { netro } from './netro.js';
import { loadConfig, saveConfig, hasController, hasSensor, defaultConfig } from './config.js';

// Netro returns timestamps as bare ISO strings without a timezone marker
// (e.g. "2026-05-31T16:06:47"), but they're UTC. JavaScript parses bare
// datetimes as LOCAL time — silently wrong by your offset. Always parse via this.
function parseNetroTime(s) {
    if (!s) return new Date(NaN);
    const hasTz = s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s);
    return new Date(hasTz ? s : s + 'Z');
}

// ---------- State ----------
let config = loadConfig();
let runCtx = null;

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
    });
});

function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === name));
    if (name === 'settings') renderSettings();
    if (name === 'timeline') loadTimeline();
    if (name === 'automation') initAutomationTab();
}

// ---------- Automation (Cloudflare Worker) ----------
const WORKER_STORE = 'netro-desktop-worker-v1';
let workerCfg = null;                       // loaded from the Worker when connected
let workerControllerInfos = new Map();      // serial -> netro device info (for zone dropdowns)

function loadWorkerCreds() {
    const raw = localStorage.getItem(WORKER_STORE);
    if (!raw) return { url: '', token: '' };
    try { return JSON.parse(raw); } catch { return { url: '', token: '' }; }
}

function saveWorkerCreds(creds) {
    localStorage.setItem(WORKER_STORE, JSON.stringify(creds));
}

function initAutomationTab() {
    const creds = loadWorkerCreds();
    document.getElementById('worker-url').value = creds.url || '';
    document.getElementById('worker-token').value = creds.token || '';
    if (creds.url && creds.token && !workerCfg) {
        connectWorker(); // auto-reconnect on tab open if we already had creds
    } else if (workerCfg) {
        renderWorkerPanel();
    }
}

async function connectWorker() {
    const url = document.getElementById('worker-url').value.trim().replace(/\/$/, '');
    const token = document.getElementById('worker-token').value.trim();
    const status = document.getElementById('worker-status');

    if (!url || !token) {
        status.textContent = 'Enter URL and token first.';
        return;
    }

    status.textContent = 'Connecting…';
    try {
        const statusResp = await fetch(`${url}/status`);
        if (!statusResp.ok) throw new Error(`Worker /status returned ${statusResp.status}`);
        const s = await statusResp.json();
        if (!s.has_token) throw new Error('Worker has no AUTH_TOKEN secret set — see SETUP step 6.');

        const cfgResp = await fetch(`${url}/config`, { headers: { Authorization: `Bearer ${token}` } });
        if (cfgResp.status === 401) throw new Error('Auth token rejected by Worker.');
        if (!cfgResp.ok) throw new Error(`/config returned ${cfgResp.status}`);

        workerCfg = await cfgResp.json();
        saveWorkerCreds({ url, token });
        status.textContent = `Connected · Worker v${s.version}`;
        await refreshControllerInfos();
        renderWorkerPanel();
    } catch (e) {
        status.textContent = '';
        toast('Connect failed: ' + e.message, 'error');
    }
}

document.getElementById('worker-connect').addEventListener('click', connectWorker);

function renderWorkerPanel() {
    document.getElementById('worker-panel').hidden = false;
    renderPatterns();
    renderLastRun();
}

// Pull live device info for every controller in workerCfg so zone dropdowns
// only show zones that are actually enabled on the Netro device.
async function refreshControllerInfos() {
    workerControllerInfos.clear();
    const controllers = workerCfg?.controllers || [];
    await Promise.all(controllers.map(async c => {
        try {
            const info = await netro.info(c.serial);
            workerControllerInfos.set(c.serial, info);
        } catch {
            // leave missing — renderPatternRow falls back to a numeric input
        }
    }));
}

function renderPatterns() {
    const list = document.getElementById('patterns-list');
    if (!workerCfg.patterns?.length) {
        list.innerHTML = `<p class="hint">No patterns yet. Click + Add pattern below.</p>`;
        return;
    }
    list.innerHTML = workerCfg.patterns.map((p, i) => renderPatternRow(p, i)).join('');
    wirePatternEvents();
}

function renderPatternRow(p, i) {
    const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const controllerOpts = (workerCfg.controllers || []).map(c =>
        `<option value="${escapeHtml(c.serial)}" ${c.serial === p.controller_serial ? 'selected' : ''}>${escapeHtml(c.nickname || c.serial)}</option>`
    ).join('');
    const days = Array.isArray(p.days) ? p.days : [];
    const dayPicker = dayLabels.map((d, idx) => `
        <label>
            <input type="checkbox" data-day="${idx}" ${days.includes(idx) ? 'checked' : ''}>
            <span>${d}</span>
        </label>
    `).join('');

    const zoneField = renderZoneField(p.controller_serial, p.zone);

    return `
        <div class="pattern-row ${p.enabled === false ? 'disabled' : ''}" data-i="${i}">
            <div class="row-top">
                <label class="field">
                    <span>Controller</span>
                    <select class="p-controller">
                        <option value="">— select —</option>
                        ${controllerOpts}
                    </select>
                </label>
                <label class="field">
                    <span>Zone</span>
                    ${zoneField}
                </label>
                <label class="field narrow">
                    <span>Time (UTC)</span>
                    <input class="p-time" type="time" value="${escapeHtml(p.preferred_time_utc || '06:00')}">
                </label>
                <label class="field compact">
                    <span>Minutes</span>
                    <input class="p-dur" type="number" min="1" max="240" value="${p.duration_min ?? 10}">
                </label>
                <label class="field">
                    <span>Note</span>
                    <input class="p-note" type="text" value="${escapeHtml(p.note || '')}" placeholder="e.g. Front Grass">
                </label>
            </div>
            <div class="row-bottom">
                <div class="day-picker">${dayPicker}</div>
                <div style="display:flex; gap:14px; align-items:center;">
                    <label class="toggle">
                        <input class="p-enabled" type="checkbox" ${p.enabled !== false ? 'checked' : ''}>
                        Enabled
                    </label>
                    <button class="btn-danger" data-remove-pattern="${i}">Remove</button>
                </div>
            </div>
        </div>`;
}

// Render the zone selector — dropdown of enabled zones if we have info,
// numeric input as a fallback if info is missing.
function renderZoneField(controllerSerial, currentZone) {
    const info = workerControllerInfos.get(controllerSerial);
    if (!info || !Array.isArray(info.zones)) {
        return `<input class="p-zone" type="number" min="1" max="24" value="${currentZone ?? 1}">`;
    }
    const activeZones = info.zones.filter(z => z.enabled);
    if (!activeZones.length) {
        return `<select class="p-zone" disabled><option>no active zones</option></select>`;
    }
    const opts = activeZones.map(z =>
        `<option value="${z.ith}" ${z.ith === currentZone ? 'selected' : ''}>${z.ith} · ${escapeHtml(z.name)}</option>`
    ).join('');
    // If currentZone isn't in the active list (e.g. previously selected then disabled in Netro), surface it.
    const isDisabledZone = currentZone && !activeZones.some(z => z.ith === currentZone);
    const orphan = isDisabledZone
        ? `<option value="${currentZone}" selected>${currentZone} · (disabled on device)</option>`
        : '';
    return `<select class="p-zone">${orphan}${opts}</select>`;
}

function wirePatternEvents() {
    document.querySelectorAll('[data-remove-pattern]').forEach(b => {
        b.addEventListener('click', () => {
            capturePatternsToWorkerCfg();
            workerCfg.patterns.splice(+b.dataset.removePattern, 1);
            renderPatterns();
        });
    });
    // When controller changes, re-render the row so the zone dropdown reflects that controller's zones.
    document.querySelectorAll('.p-controller').forEach(sel => {
        sel.addEventListener('change', () => {
            capturePatternsToWorkerCfg();
            renderPatterns();
        });
    });
}

function capturePatternsToWorkerCfg() {
    const rows = [...document.querySelectorAll('.pattern-row')];
    workerCfg.patterns = rows.map(row => {
        const days = [...row.querySelectorAll('.day-picker input:checked')].map(i => +i.dataset.day);
        const existing = workerCfg.patterns[+row.dataset.i] || {};
        return {
            id: existing.id || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
            enabled: row.querySelector('.p-enabled').checked,
            controller_serial: row.querySelector('.p-controller').value.trim().toLowerCase(),
            zone: parseInt(row.querySelector('.p-zone').value) || 1,
            preferred_time_utc: row.querySelector('.p-time').value || '06:00',
            duration_min: parseInt(row.querySelector('.p-dur').value) || 10,
            note: row.querySelector('.p-note').value.trim(),
            days,
        };
    });
}

document.getElementById('add-pattern').addEventListener('click', () => {
    if (!workerCfg) return;
    capturePatternsToWorkerCfg();
    workerCfg.patterns = workerCfg.patterns || [];
    workerCfg.patterns.push({
        id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
        enabled: true,
        controller_serial: workerCfg.controllers?.[0]?.serial || '',
        zone: 1,
        days: [1, 3, 5], // Mon/Wed/Fri default
        preferred_time_utc: '06:00',
        duration_min: 10,
        note: '',
    });
    renderPatterns();
});

document.getElementById('sync-from-local').addEventListener('click', async () => {
    if (!workerCfg) return;
    workerCfg.controllers = config.controllers.map(c => ({
        serial: c.serial,
        nickname: c.nickname,
    }));
    workerCfg.borehole_capacity_lpm = config.borehole_capacity_lpm ?? workerCfg.borehole_capacity_lpm;
    workerCfg.default_zone_flow_lpm = config.default_zone_flow_lpm ?? workerCfg.default_zone_flow_lpm;
    await refreshControllerInfos(); // pick up any newly-synced controllers' zone lists
    renderPatterns();
    toast(`Synced ${workerCfg.controllers.length} controllers + borehole capacity`, 'success');
});

document.getElementById('save-worker-config').addEventListener('click', async () => {
    if (!workerCfg) return;
    capturePatternsToWorkerCfg();
    const status = document.getElementById('worker-save-status');
    status.textContent = 'Saving…';
    const creds = loadWorkerCreds();
    try {
        const r = await fetch(`${creds.url}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
            body: JSON.stringify(workerCfg),
        });
        if (!r.ok) throw new Error(`save returned ${r.status}`);
        status.textContent = 'Saved';
        toast('Patterns saved to Worker', 'success');
        setTimeout(() => status.textContent = '', 2500);
    } catch (e) {
        status.textContent = '';
        toast('Save failed: ' + e.message, 'error');
    }
});

document.getElementById('run-now').addEventListener('click', async () => {
    if (!workerCfg) return;
    const creds = loadWorkerCreds();
    toast('Running today\'s schedule on the Worker…');
    try {
        const r = await fetch(`${creds.url}/run-now`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!r.ok) throw new Error(`run-now returned ${r.status}`);
        const result = await r.json();
        workerCfg.last_run = result;
        renderLastRun();
        toast(`Queued ${result.placed} watering${result.placed !== 1 ? 's' : ''}${result.failed ? ` (${result.failed} failed)` : ''}`, result.failed ? 'error' : 'success');
    } catch (e) {
        toast('Run failed: ' + e.message, 'error');
    }
});

function renderLastRun() {
    const el = document.getElementById('last-run-info');
    if (!workerCfg.last_run) {
        el.textContent = 'No runs recorded yet.';
        return;
    }
    const r = workerCfg.last_run;
    const when = new Date(r.ts).toLocaleString();
    const lines = [`Last run: ${when} — placed ${r.placed}${r.failed ? `, failed ${r.failed}` : ''}`];
    if (r.message) lines.push(`  ${r.message}`);
    for (const p of r.pushed || []) {
        const name = workerCfg.controllers?.find(c => c.serial === p.serial)?.nickname || p.serial;
        lines.push(`  ✓ ${name} zone ${p.zone} @ ${new Date(p.start).toLocaleTimeString()} for ${p.duration} min`);
    }
    for (const f of r.failed || []) {
        const name = workerCfg.controllers?.find(c => c.serial === f.serial)?.nickname || f.serial;
        lines.push(`  ✗ ${name} zone ${f.zone}: ${f.error}`);
    }
    el.innerHTML = `<div class="run-log">${escapeHtml(lines.join('\n'))}</div>`;
}

// ---------- Timeline ----------
const CONTROLLER_COLORS = ['#4cc2ff', '#b794f6', '#f6ad55', '#68d391', '#fc8181', '#f6e05e'];

function colorFor(serial) {
    if (!colorFor._map) colorFor._map = new Map();
    if (!colorFor._map.has(serial)) {
        colorFor._map.set(serial, CONTROLLER_COLORS[colorFor._map.size % CONTROLLER_COLORS.length]);
    }
    return colorFor._map.get(serial);
}

function toIsoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

async function loadTimeline() {
    const container = document.getElementById('timeline-content');
    const legend = document.getElementById('timeline-legend');

    if (!hasController(config)) {
        container.innerHTML = `<div class="placeholder">Add a controller in Settings first.</div>`;
        legend.innerHTML = '';
        return;
    }

    container.innerHTML = `<div class="loading">Loading…</div>`;

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const startStr = toIsoDate(start);
    const endStr = toIsoDate(end);

    // Look up zone names so blocks can be labelled.
    const infoByController = new Map();
    const schedulesByController = new Map();
    const errors = [];

    await Promise.all(config.controllers.map(async c => {
        try {
            const [info, schedules] = await Promise.all([
                netro.info(c.serial),
                netro.schedules(c.serial, { start_date: startStr, end_date: endStr }),
            ]);
            infoByController.set(c.serial, info);
            schedulesByController.set(c.serial, schedules);
        } catch (e) {
            errors.push(`${c.nickname}: ${e.message}`);
            schedulesByController.set(c.serial, []);
        }
    }));

    // Legend
    legend.innerHTML = config.controllers.map(c => `
        <span class="legend-item">
            <span class="legend-swatch" style="background:${colorFor(c.serial)}"></span>
            ${escapeHtml(c.nickname || c.serial)}
        </span>
    `).join('');

    // Compute conflicts across all controllers (sweep line).
    const capacity = config.borehole_capacity_lpm;
    const zoneFlow = config.default_zone_flow_lpm || capacity; // default to capacity → any overlap is a conflict
    const conflicts = capacity ? computeConflicts(schedulesByController, zoneFlow, capacity) : [];

    // Summary banner
    let summaryHtml = '';
    if (!capacity) {
        summaryHtml = `<div class="timeline-summary">Set a borehole capacity in Settings to enable conflict detection.</div>`;
    } else if (conflicts.length === 0) {
        summaryHtml = `<div class="timeline-summary ok">✓ No borehole capacity conflicts in the next 7 days (capacity ${capacity} L/min, zone flow ${zoneFlow} L/min)</div>`;
    } else {
        summaryHtml = `<div class="timeline-summary warn">⚠ ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} where simultaneous flow exceeds the ${capacity} L/min borehole capacity. Each conflict is shown in red on the timeline below.</div>`;
    }

    // Build days
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        days.push(d);
    }

    container.innerHTML = summaryHtml + days.map(d => renderDayCard(d, schedulesByController, infoByController, conflicts)).join('');

    if (errors.length) toast('Some schedules failed: ' + errors.join('; '), 'error');
}

function computeConflicts(schedulesByController, zoneFlowLpm, capacityLpm) {
    // Build a sorted event list: +flow at watering start, -flow at watering end.
    const events = [];
    for (const scheds of schedulesByController.values()) {
        for (const s of scheds) {
            events.push({ t: parseNetroTime(s.start_time).getTime(), delta: +zoneFlowLpm });
            events.push({ t: parseNetroTime(s.end_time).getTime(),   delta: -zoneFlowLpm });
        }
    }
    events.sort((a, b) => a.t - b.t || a.delta - b.delta); // ends before starts at same instant

    const conflicts = [];
    let current = 0;
    let conflictStart = null;
    let conflictPeak = 0;
    for (const ev of events) {
        const newCurrent = current + ev.delta;
        const wasOver = current > capacityLpm + 0.0001;
        const isOver = newCurrent > capacityLpm + 0.0001;
        if (!wasOver && isOver) {
            conflictStart = ev.t;
            conflictPeak = newCurrent;
        }
        if (wasOver) conflictPeak = Math.max(conflictPeak, newCurrent);
        if (wasOver && !isOver) {
            conflicts.push({ start: new Date(conflictStart), end: new Date(ev.t), peak: conflictPeak });
            conflictStart = null;
            conflictPeak = 0;
        }
        current = newCurrent;
    }
    return conflicts;
}

function renderDayCard(dayDate, schedulesByController, infoByController, conflicts = []) {
    const dayStart = new Date(dayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const now = new Date();
    const isToday = now >= dayStart && now < dayEnd;

    const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
    const dayDiff = Math.round((dayStart - todayMidnight) / 86400000);
    let label;
    if (dayDiff === 0) label = 'Today';
    else if (dayDiff === 1) label = 'Tomorrow';
    else label = dayDate.toLocaleDateString(undefined, { weekday: 'long' });

    const dateStr = dayDate.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    // Collect blocks per controller for this day.
    const lanes = config.controllers.map(c => {
        const scheds = (schedulesByController.get(c.serial) || []).filter(s => {
            const st = parseNetroTime(s.start_time);
            const en = parseNetroTime(s.end_time);
            return en > dayStart && st < dayEnd;
        });
        return { cfg: c, info: infoByController.get(c.serial), scheds };
    });

    const totalScheds = lanes.reduce((n, l) => n + l.scheds.length, 0);

    // Conflict bands that overlap this day, clipped to the day.
    const dayConflicts = conflicts
        .filter(c => c.end > dayStart && c.start < dayEnd)
        .map(c => ({
            start: c.start < dayStart ? dayStart : c.start,
            end:   c.end > dayEnd ? dayEnd : c.end,
            peak:  c.peak,
        }));

    const conflictBands = dayConflicts.map(c => {
        const leftPct = ((c.start - dayStart) / 86400000) * 100;
        const widthPct = Math.max(0.3, ((c.end - c.start) / 86400000) * 100);
        const tip = `Conflict ${formatTime(c.start)}–${formatTime(c.end)} · peak ${c.peak.toFixed(1)} L/min`;
        return `<div class="conflict-band" style="left:${leftPct}%; width:${widthPct}%" title="${escapeHtml(tip)}"></div>`;
    }).join('');

    // Hour ruler (00, 06, 12, 18, 24)
    const hourTicks = [0, 6, 12, 18, 24].map(h => `
        <span class="hour-tick" style="left:${(h / 24) * 100}%"></span>
        <span class="hour-label" style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}</span>
    `).join('');

    // "Now" line only for today
    let nowMarker = '';
    if (isToday) {
        const pct = ((now - dayStart) / 86400000) * 100;
        nowMarker = `<span class="timeline-now" style="left:${pct}%"></span>`;
    }

    const laneRows = lanes.map(({ cfg, info, scheds }) => {
        const blocks = scheds.map(s => {
            const st = Math.max(parseNetroTime(s.start_time), dayStart);
            const en = Math.min(parseNetroTime(s.end_time), dayEnd);
            const leftPct = ((st - dayStart) / 86400000) * 100;
            const widthPct = Math.max(0.3, ((en - st) / 86400000) * 100);
            const zoneName = info?.zones?.find(z => z.ith === s.zone)?.name || `Zone ${s.zone}`;
            const past = en <= now ? 'past' : '';
            const tooltip = `${zoneName} · ${formatTime(parseNetroTime(s.start_time))}–${formatTime(parseNetroTime(s.end_time))} · ${Math.round((parseNetroTime(s.end_time) - parseNetroTime(s.start_time)) / 60000)} min`;
            return `
                <div class="water-block ${past}"
                     style="left:${leftPct}%; width:${widthPct}%; background:${colorFor(cfg.serial)}"
                     title="${escapeHtml(tooltip)}">${escapeHtml(zoneName)}</div>`;
        }).join('');
        return `
            <div class="controller-lane">
                <div class="lane-label">${escapeHtml(cfg.nickname || cfg.serial)}</div>
                <div class="lane-track">${conflictBands}${nowMarker}${blocks}</div>
            </div>`;
    }).join('');

    const conflictSummary = dayConflicts.length
        ? `<div class="day-conflicts">⚠ ${dayConflicts.length} conflict${dayConflicts.length > 1 ? 's' : ''} today</div>`
        : '';

    return `
        <div class="day-card">
            <div class="day-header">
                <div>
                    <span class="day-name ${isToday ? 'today' : ''}">${label}</span>
                    <span class="day-date">${dateStr}</span>
                    ${conflictSummary}
                </div>
                ${totalScheds === 0 ? `<span class="day-empty">No waterings scheduled</span>` : ''}
            </div>
            ${totalScheds > 0 ? `
                <div class="hour-ruler">${hourTicks}</div>
                ${laneRows}
            ` : ''}
        </div>`;
}

function formatTime(d) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ---------- Toast ----------
function toast(msg, kind = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.hidden = true, 2800);
}

// ---------- Dashboard ----------
async function loadDashboard() {
    const refresh = document.getElementById('refresh-btn');
    refresh.classList.add('spinning');
    try {
        await Promise.all([loadControllers(), loadSensors(), loadStatusBar()]);
    } catch (e) {
        toast('Failed to load: ' + e.message, 'error');
    } finally {
        refresh.classList.remove('spinning');
    }
}

// Fetch a 48h window of schedules across all controllers, compute what's running
// right now and what's next, and render the top status bar.
async function loadStatusBar() {
    const bar = document.getElementById('status-bar');
    const nowEl = document.getElementById('status-now');
    const nextEl = document.getElementById('status-next');

    if (!hasController(config)) {
        bar.hidden = true;
        return;
    }
    bar.hidden = false;

    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86400000);
    const startStr = toIsoDate(today);
    const endStr = toIsoDate(tomorrow);

    // Need info too so we can label by zone name.
    const all = await Promise.all(config.controllers.map(async c => {
        try {
            const [info, scheds] = await Promise.all([
                netro.info(c.serial),
                netro.schedules(c.serial, { start_date: startStr, end_date: endStr }),
            ]);
            return { cfg: c, info, scheds };
        } catch {
            return { cfg: c, info: null, scheds: [] };
        }
    }));

    const now = Date.now();
    const running = [];
    const upcoming = [];
    for (const { cfg, info, scheds } of all) {
        for (const s of scheds) {
            const st = parseNetroTime(s.start_time).getTime();
            const en = parseNetroTime(s.end_time).getTime();
            const zoneName = info?.zones?.find(z => z.ith === s.zone)?.name || `Zone ${s.zone}`;
            if (st <= now && en > now) {
                running.push({ cfg, zone: s.zone, zoneName, endMs: en });
            } else if (st > now) {
                upcoming.push({ cfg, zone: s.zone, zoneName, startMs: st, durMs: en - st });
            }
        }
    }

    // Render "Now"
    if (running.length === 0) {
        nowEl.className = 'status-value';
        nowEl.textContent = 'Nothing running';
        bar.classList.remove('live');
    } else {
        nowEl.className = 'status-value running';
        nowEl.textContent = running
            .map(r => `${r.cfg.nickname} · ${r.zoneName} (${formatRemaining(r.endMs - now)} left)`)
            .join(' · ');
        bar.classList.add('live');
    }

    // Render "Next"
    upcoming.sort((a, b) => a.startMs - b.startMs);
    if (upcoming.length === 0) {
        nextEl.textContent = 'No waterings in next 48h';
    } else {
        const u = upcoming[0];
        const startTime = new Date(u.startMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
        const whenSuffix = isTomorrow(new Date(u.startMs)) ? ' tomorrow' : '';
        nextEl.textContent = `${u.cfg.nickname} · ${u.zoneName} at ${startTime}${whenSuffix} (in ${formatRemaining(u.startMs - now)})`;
    }
}

function formatRemaining(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 60) return `${min} min`;
    const hr = Math.floor(min / 60);
    const rem = min % 60;
    return rem ? `${hr}h ${rem}m` : `${hr}h`;
}

function isTomorrow(d) {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
}

async function loadControllers() {
    const container = document.getElementById('controllers');

    if (!hasController(config)) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No controllers yet</h3>
                <p>Add your first Netro controller in Settings to get started.</p>
                <button class="btn-primary" id="empty-go-settings">Open Settings</button>
            </div>`;
        document.getElementById('empty-go-settings').addEventListener('click', () => switchTab('settings'));
        return;
    }

    const cards = await Promise.all(config.controllers.map(async c => {
        try {
            const info = await netro.info(c.serial);
            return renderControllerCard(c, info, null);
        } catch (e) {
            return renderControllerCard(c, null, e.message);
        }
    }));

    container.innerHTML = cards.join('');
    wireCardEvents();
}

async function loadSensors() {
    const section = document.getElementById('sensors-section');
    const grid = document.getElementById('sensors');

    if (!hasSensor(config)) {
        section.hidden = true;
        return;
    }
    section.hidden = false;

    const cards = await Promise.all(config.sensors.map(async s => {
        try {
            const [info, dataArr] = await Promise.all([
                netro.sensorInfo(s.serial),
                netro.sensorData(s.serial).catch(() => []),
            ]);
            const latest = dataArr.length ? dataArr[dataArr.length - 1] : null;
            return renderSensorCard(s, info, latest, null);
        } catch (e) {
            return renderSensorCard(s, null, null, e.message);
        }
    }));

    grid.innerHTML = cards.join('');
}

function renderSensorCard(cfg, info, latest, errorMsg) {
    const name = cfg.nickname || info?.name || 'Sensor';

    if (errorMsg) {
        return `
            <div class="sensor-card">
                <div class="sensor-card-header">
                    <div>
                        <h3 class="sensor-name">${escapeHtml(name)}</h3>
                        <div class="sensor-serial">${escapeHtml(cfg.serial)}</div>
                    </div>
                    <span class="status-pill offline">error</span>
                </div>
                <div class="sensor-footer">${escapeHtml(errorMsg)}</div>
            </div>`;
    }

    const status = (info.status || '').toUpperCase();
    const isOffline = status === 'OFFLINE';
    const statusClass = isOffline ? 'offline' : '';
    const statusText = isOffline ? 'offline' : status.toLowerCase() || 'online';

    const batteryPct = info.battery_level != null ? Math.round(info.battery_level * 100) : null;
    const batteryClass = batteryPct == null ? '' : (batteryPct < 20 ? 'bad' : (batteryPct < 40 ? 'warn' : ''));
    const batteryDisplay = batteryPct != null ? `${batteryPct}%` : '—';

    // Latest reading: moisture (%) and temperature (°C). Light if present.
    const moisture = latest?.moisture != null ? `${Math.round(latest.moisture)}%` : '—';
    const temp = latest?.celsius != null
        ? `${latest.celsius.toFixed(1)}°C`
        : (latest?.fahrenheit != null ? `${(((latest.fahrenheit - 32) * 5) / 9).toFixed(1)}°C` : '—');

    const lastSeen = info.last_active ? formatAgo(info.last_active) : 'never';

    return `
        <div class="sensor-card">
            <div class="sensor-card-header">
                <div>
                    <h3 class="sensor-name">${escapeHtml(name)}</h3>
                    <div class="sensor-serial">${escapeHtml(cfg.serial)}</div>
                </div>
                <span class="status-pill ${statusClass}">${statusText}</span>
            </div>
            <div class="sensor-metrics">
                <div class="metric">
                    <div class="metric-label">Moisture</div>
                    <div class="metric-value">${moisture}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Temperature</div>
                    <div class="metric-value">${temp}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Battery</div>
                    <div class="metric-value ${batteryClass}">${batteryDisplay}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Last seen</div>
                    <div class="metric-value" style="font-size:13px;">${lastSeen}</div>
                </div>
            </div>
        </div>`;
}

function formatAgo(iso) {
    const then = parseNetroTime(iso);
    if (isNaN(then)) return iso;
    const diffMs = Date.now() - then.getTime();
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} day${day > 1 ? 's' : ''} ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo} mo ago`;
    const yr = Math.floor(day / 365);
    return `${yr} yr${yr > 1 ? 's' : ''} ago`;
}

function renderControllerCard(cfg, info, errorMsg) {
    if (errorMsg) {
        return `
            <div class="controller-card">
                <div class="controller-card-header">
                    <div>
                        <h3 class="controller-name">${escapeHtml(cfg.nickname || 'Unnamed')}</h3>
                        <div class="controller-serial">${escapeHtml(cfg.serial)}</div>
                    </div>
                    <span class="status-pill offline">offline</span>
                </div>
                <div class="placeholder" style="padding:14px;">Couldn't reach controller: ${escapeHtml(errorMsg)}</div>
            </div>`;
    }

    const enabled = (info.status || '').toUpperCase() !== 'STANDBY';
    const statusClass = enabled ? '' : 'disabled';
    const statusText = enabled ? 'online' : 'standby';

    const activeZones = info.zones.filter(z => z.enabled);
    const zoneRows = activeZones.map(z => `
        <div class="zone-row" data-zone="${z.ith}">
            <div class="zone-info">
                <span class="zone-num">${z.ith}</span>
                <span class="zone-name">${escapeHtml(z.name)}</span>
            </div>
            <div class="zone-actions">
                <button data-action="run" data-serial="${cfg.serial}" data-zone="${z.ith}" data-zname="${escapeHtml(z.name)}">Run</button>
            </div>
        </div>
    `).join('');

    return `
        <div class="controller-card">
            <div class="controller-card-header">
                <div>
                    <h3 class="controller-name">${escapeHtml(cfg.nickname || info.name)}</h3>
                    <div class="controller-serial">${escapeHtml(cfg.serial)} · ${activeZones.length} of ${info.zone_num} zones active</div>
                </div>
                <span class="status-pill ${statusClass}">${statusText}</span>
            </div>
            <div class="zone-list">${zoneRows}</div>
            <div class="controller-actions">
                <button class="btn-secondary" data-action="stop" data-serial="${cfg.serial}">Stop all</button>
                <button class="btn-secondary" data-action="skip" data-serial="${cfg.serial}">Skip day…</button>
                <button class="btn-secondary" data-action="toggle" data-serial="${cfg.serial}" data-enabled="${enabled}">${enabled ? 'Disable' : 'Enable'}</button>
            </div>
        </div>`;
}

function wireCardEvents() {
    document.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', handleCardAction);
    });
}

async function handleCardAction(e) {
    const action = e.currentTarget.dataset.action;
    const serial = e.currentTarget.dataset.serial;
    try {
        if (action === 'run') {
            openRunModal(serial, +e.currentTarget.dataset.zone, e.currentTarget.dataset.zname);
        } else if (action === 'stop') {
            await netro.stopWater(serial);
            toast('Stopped', 'success');
        } else if (action === 'skip') {
            const days = prompt('Skip watering for how many days? (1-100)', '1');
            const n = parseInt(days);
            if (!n || n < 1 || n > 100) return;
            await netro.noWater(serial, n);
            toast(`Skipping ${n} day${n > 1 ? 's' : ''}`, 'success');
        } else if (action === 'toggle') {
            const wasEnabled = e.currentTarget.dataset.enabled === 'true';
            await netro.setStatus(serial, !wasEnabled);
            toast(wasEnabled ? 'Disabled' : 'Enabled', 'success');
            loadDashboard();
        }
    } catch (err) {
        toast('Error: ' + err.message, 'error');
    }
}

// ---------- Run modal ----------
function openRunModal(serial, zone, zname) {
    runCtx = { serial, zone };
    document.getElementById('run-modal-body').textContent = `Zone ${zone}: ${zname}`;
    document.getElementById('run-duration').value = '10';
    document.getElementById('run-modal').hidden = false;
    document.getElementById('run-duration').focus();
}

function closeRunModal() {
    document.getElementById('run-modal').hidden = true;
    runCtx = null;
}

document.getElementById('run-confirm').addEventListener('click', async () => {
    if (!runCtx) return;
    const min = parseInt(document.getElementById('run-duration').value);
    if (!min || min < 1) { toast('Enter a duration', 'error'); return; }
    try {
        await netro.water(runCtx.serial, [runCtx.zone], min);
        toast(`Watering started (${min} min)`, 'success');
        closeRunModal();
    } catch (e) {
        toast('Error: ' + e.message, 'error');
    }
});

document.querySelectorAll('[data-close-modal]').forEach(b =>
    b.addEventListener('click', closeRunModal)
);

document.getElementById('run-modal').addEventListener('click', (e) => {
    if (e.target.id === 'run-modal') closeRunModal();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('run-modal').hidden) closeRunModal();
});

// ---------- Settings ----------
function renderSettings() {
    document.getElementById('borehole-lpm').value = config.borehole_capacity_lpm ?? '';
    document.getElementById('default-zone-flow').value = config.default_zone_flow_lpm ?? '';

    renderEditList(
        'controller-edit-list',
        config.controllers,
        'controller',
        'Cart Lodge',
        i => {
            captureSettingsToConfig();
            config.controllers.splice(i, 1);
            renderSettings();
        }
    );

    renderEditList(
        'sensor-edit-list',
        config.sensors,
        'sensor',
        'Yew Hedge sensor',
        i => {
            captureSettingsToConfig();
            config.sensors.splice(i, 1);
            renderSettings();
        }
    );
}

function renderEditList(elementId, items, kind, nicknamePlaceholder, onRemove) {
    const list = document.getElementById(elementId);
    if (!items.length) {
        list.innerHTML = `<p class="hint">No ${kind}s added yet. Click + Add ${kind} below.</p>`;
        return;
    }
    list.innerHTML = items.map((c, i) => `
        <div class="controller-edit-row" data-i="${i}">
            <div class="row-head">
                <label class="field">
                    <span>Nickname</span>
                    <input class="ec-nick-${kind}" type="text" value="${escapeHtml(c.nickname || '')}" placeholder="e.g. ${escapeHtml(nicknamePlaceholder)}">
                </label>
                <label class="field">
                    <span>Serial number</span>
                    <input class="ec-serial-${kind}" type="text" value="${escapeHtml(c.serial || '')}" placeholder="12-char hex">
                </label>
                <button class="btn-danger" data-remove="${i}">Remove</button>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('[data-remove]').forEach(b => {
        b.addEventListener('click', () => onRemove(+b.dataset.remove));
    });
}

function captureSettingsToConfig() {
    const cNicks = [...document.querySelectorAll('.ec-nick-controller')];
    const cSerials = [...document.querySelectorAll('.ec-serial-controller')];
    config.controllers = cNicks.map((n, i) => ({
        serial: cSerials[i].value.trim().toLowerCase(),
        nickname: n.value.trim() || 'Controller',
        zone_flow_lpm: config.controllers[i]?.zone_flow_lpm ?? {},
    }));

    const sNicks = [...document.querySelectorAll('.ec-nick-sensor')];
    const sSerials = [...document.querySelectorAll('.ec-serial-sensor')];
    config.sensors = sNicks.map((n, i) => ({
        serial: sSerials[i].value.trim().toLowerCase(),
        nickname: n.value.trim(),
    }));

    const bh = document.getElementById('borehole-lpm').value;
    config.borehole_capacity_lpm = bh ? parseFloat(bh) : null;
    const dz = document.getElementById('default-zone-flow').value;
    config.default_zone_flow_lpm = dz ? parseFloat(dz) : null;
}

document.getElementById('add-controller').addEventListener('click', () => {
    captureSettingsToConfig();
    config.controllers.push({ serial: '', nickname: '', zone_flow_lpm: {} });
    renderSettings();
});

document.getElementById('add-sensor').addEventListener('click', () => {
    captureSettingsToConfig();
    config.sensors.push({ serial: '', nickname: '' });
    renderSettings();
});

document.getElementById('save-config').addEventListener('click', async () => {
    captureSettingsToConfig();

    // Drop rows without a serial.
    config.controllers = config.controllers.filter(c => c.serial);
    config.sensors = config.sensors.filter(s => s.serial);

    const status = document.getElementById('save-status');
    status.textContent = 'Validating…';

    // Quick validation: ping each device; flag any that fail.
    const failures = [];
    for (const c of config.controllers) {
        try { await netro.info(c.serial); }
        catch (e) { failures.push(`${c.nickname || c.serial}: ${e.message}`); }
    }
    for (const s of config.sensors) {
        try { await netro.sensorInfo(s.serial); }
        catch (e) { failures.push(`${s.nickname || s.serial}: ${e.message}`); }
    }

    saveConfig(config);
    status.textContent = failures.length ? 'Saved with warnings' : 'Saved';
    if (failures.length) {
        toast('Saved, but some devices failed: ' + failures.join('; '), 'error');
    } else {
        toast('Settings saved', 'success');
    }
    setTimeout(() => status.textContent = '', 2500);
    loadDashboard();
});

// ---------- Refresh ----------
document.getElementById('refresh-btn').addEventListener('click', loadDashboard);

// ---------- Utils ----------
function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

// ---------- Init ----------
if (!hasController(config)) switchTab('settings');
loadDashboard();
