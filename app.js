import { netro } from './netro.js';
import {
    loadConfig, saveConfig, hasController, hasSensor, defaultConfig,
    loadWorkerCreds, saveWorkerCreds, hasWorkerCreds,
    fetchFromWorker, pushToWorker,
} from './config.js';

// Netro returns timestamps as bare ISO strings without a timezone marker
// (e.g. "2026-05-31T16:06:47"), but they're UTC. JavaScript parses bare
// datetimes as LOCAL time — silently wrong by your offset. Always parse via this.
function parseNetroTime(s) {
    if (!s) return new Date(NaN);
    const hasTz = s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s);
    return new Date(hasTz ? s : s + 'Z');
}

// ---------- State ----------
let config = defaultConfig(); // populated by initConfig() below
let configSource = 'local';   // 'cloud' | 'cache' | 'local' — drives the sync indicator
let runCtx = null;
let dashboardControllerInfos = new Map(); // serial -> netro device info, cached so status-bar refresh
                                          // only needs /schedules calls (saves API budget).

async function initConfig() {
    const { cfg, source } = await loadConfig();
    config = cfg;
    configSource = source;
    updateSyncBadge();
}

function updateSyncBadge() {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    if (configSource === 'cloud') {
        badge.textContent = '☁ synced';
        badge.title = 'Reading config from your Cloudflare Worker. Changes save to cloud and propagate to your other devices.';
        badge.className = 'sync-badge ok';
    } else if (configSource === 'cache') {
        badge.textContent = '⚠ offline cache';
        badge.title = 'Could not reach your Worker. Showing last-known config from this device.';
        badge.className = 'sync-badge warn';
    } else {
        badge.textContent = '● local only';
        badge.title = 'No Worker configured. This device\'s config is not shared with your other devices. Set one up in Automation.';
        badge.className = 'sync-badge';
    }
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
    });
});

function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === name));
    // Status bar appears on Dashboard + Timeline (both are operational views).
    const showStatus = (name === 'dashboard' || name === 'timeline') && hasController(config);
    const bar = document.getElementById('status-bar');
    if (showStatus) {
        if (bar.hidden) loadStatusBar(); // refresh on entry if it was hidden
    } else {
        bar.hidden = true;
    }
    if (name === 'settings') renderSettings();
    if (name === 'timeline') loadTimeline();
    if (name === 'history') loadHistory();
    if (name === 'automation') initAutomationTab();
}

// ---------- Automation (Cloudflare Worker) ----------
let workerCfg = null;                       // loaded from the Worker when connected
let workerControllerInfos = new Map();      // serial -> netro device info (for zone dropdowns)

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

        // Now that creds are saved, the dashboard config can come from the cloud too.
        await initConfig();
        loadDashboard();
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

document.getElementById('eval-rules-now').addEventListener('click', async () => {
    if (!workerCfg) return;
    const creds = loadWorkerCreds();
    toast('Evaluating sensor rules on the Worker…');
    try {
        const r = await fetch(`${creds.url}/evaluate-rules-now`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!r.ok) throw new Error(`evaluate returned ${r.status}`);
        const result = await r.json();
        const tt = result.triggered || 0;
        const ff = result.failed || 0;
        toast(`Checked ${result.checked || 0} sensor(s) · triggered ${tt}${ff ? ` · failed ${ff}` : ''}`, ff ? 'error' : 'success');
        console.log('Sensor rules result:', result);
    } catch (e) {
        toast('Evaluate failed: ' + e.message, 'error');
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

    // Per-source conflict detection. Only zones from controllers tied to each source
    // count against that source's capacity.
    const conflictsBySource = {};
    const summaryParts = [];
    for (const source of ['borehole', 'mains']) {
        const capacity = source === 'borehole' ? config.borehole_capacity_lpm : config.mains_capacity_lpm;
        if (!capacity) continue;
        const sourceSerials = new Set(config.controllers.filter(c => (c.water_source || 'borehole') === source).map(c => c.serial));
        if (!sourceSerials.size) continue;
        const subset = new Map();
        for (const [serial, scheds] of schedulesByController) {
            if (sourceSerials.has(serial)) subset.set(serial, scheds);
        }
        const zoneFlow = config.default_zone_flow_lpm || capacity;
        const cs = computeConflicts(subset, zoneFlow, capacity);
        conflictsBySource[source] = cs;
        if (cs.length === 0) {
            summaryParts.push(`<span class="src-ok">✓ ${capitalize(source)}: no conflicts (${capacity} L/min)</span>`);
        } else {
            summaryParts.push(`<span class="src-warn">⚠ ${capitalize(source)}: ${cs.length} conflict${cs.length > 1 ? 's' : ''} (${capacity} L/min)</span>`);
        }
    }

    let summaryHtml;
    if (!summaryParts.length) {
        summaryHtml = `<div class="timeline-summary">Set a borehole or mains capacity in Settings to enable conflict detection.</div>`;
    } else {
        const anyWarn = Object.values(conflictsBySource).some(cs => cs.length > 0);
        summaryHtml = `<div class="timeline-summary ${anyWarn ? 'warn' : 'ok'}">${summaryParts.join(' &nbsp;·&nbsp; ')}</div>`;
    }

    // Build days
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        days.push(d);
    }

    container.innerHTML = summaryHtml + days.map(d => renderDayCard(d, schedulesByController, infoByController, conflictsBySource)).join('');
    wireTimelineSourceSelects();

    if (errors.length) toast('Some schedules failed: ' + errors.join('; '), 'error');
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function wireTimelineSourceSelects() {
    document.querySelectorAll('.lane-source-select').forEach(sel => {
        sel.addEventListener('change', async () => {
            const serial = sel.dataset.serial;
            const ctrl = config.controllers.find(c => c.serial === serial);
            if (!ctrl) return;
            ctrl.water_source = sel.value;
            await saveConfig(config);
            toast(`${ctrl.nickname || serial} → ${sel.value}`, 'success');
            loadTimeline();
        });
    });
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

function renderDayCard(dayDate, schedulesByController, infoByController, conflictsBySource = {}) {
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

    const lanes = config.controllers.map(c => {
        const scheds = (schedulesByController.get(c.serial) || []).filter(s => {
            const st = parseNetroTime(s.start_time);
            const en = parseNetroTime(s.end_time);
            return en > dayStart && st < dayEnd;
        });
        return { cfg: c, info: infoByController.get(c.serial), scheds };
    });

    const totalScheds = lanes.reduce((n, l) => n + l.scheds.length, 0);

    // Pre-compute conflict bands per source, clipped to this day.
    const bandsBySource = {};
    let dayConflictCount = 0;
    for (const [source, conflicts] of Object.entries(conflictsBySource)) {
        const dayConflicts = conflicts
            .filter(c => c.end > dayStart && c.start < dayEnd)
            .map(c => ({
                start: c.start < dayStart ? dayStart : c.start,
                end:   c.end > dayEnd ? dayEnd : c.end,
                peak:  c.peak,
            }));
        dayConflictCount += dayConflicts.length;
        bandsBySource[source] = dayConflicts.map(c => {
            const leftPct = ((c.start - dayStart) / 86400000) * 100;
            const widthPct = Math.max(0.3, ((c.end - c.start) / 86400000) * 100);
            const tip = `${capitalize(source)} conflict ${formatTime(c.start)}–${formatTime(c.end)} · peak ${c.peak.toFixed(1)} L/min`;
            return `<div class="conflict-band" style="left:${leftPct}%; width:${widthPct}%" title="${escapeHtml(tip)}"></div>`;
        }).join('');
    }

    const hourTicks = [0, 6, 12, 18, 24].map(h => `
        <span class="hour-tick" style="left:${(h / 24) * 100}%"></span>
        <span class="hour-label" style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}</span>
    `).join('');

    let nowMarker = '';
    if (isToday) {
        const pct = ((now - dayStart) / 86400000) * 100;
        nowMarker = `<span class="timeline-now" style="left:${pct}%"></span>`;
    }

    const laneRows = lanes.map(({ cfg, info, scheds }) => {
        const source = cfg.water_source || 'borehole';
        // Only show this source's conflict bands inside this lane (mains conflict in a borehole row is meaningless).
        const conflictBands = bandsBySource[source] || '';
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
                <div class="lane-label">
                    <span class="lane-nick">${escapeHtml(cfg.nickname || cfg.serial)}</span>
                    <select class="lane-source-select" data-serial="${escapeHtml(cfg.serial)}" title="Water source for this controller">
                        <option value="borehole" ${source === 'borehole' ? 'selected' : ''}>Borehole</option>
                        <option value="mains" ${source === 'mains' ? 'selected' : ''}>Mains</option>
                    </select>
                </div>
                <div class="lane-track">${conflictBands}${nowMarker}${blocks}</div>
            </div>`;
    }).join('');

    const conflictSummary = dayConflictCount
        ? `<div class="day-conflicts">⚠ ${dayConflictCount} conflict${dayConflictCount > 1 ? 's' : ''} today</div>`
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
        await Promise.all([loadControllers(), loadSensors(), loadStatusBar(), loadSavings()]);
    } catch (e) {
        toast('Failed to load: ' + e.message, 'error');
    } finally {
        refresh.classList.remove('spinning');
    }
}

// Cost per cubic metre of mains water — used to estimate borehole savings.

const SAVINGS_WINDOW_KEY = 'netro-desktop-savings-window-v1';
function loadSavingsWindow() { return localStorage.getItem(SAVINGS_WINDOW_KEY) || '7d'; }
function saveSavingsWindow(w) { localStorage.setItem(SAVINGS_WINDOW_KEY, w); }

// Returns { start: Date, label: string } for a window key, or null if not applicable.
function savingsRangeFor(windowKey, now = new Date()) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    if (windowKey === '7d') {
        const s = new Date(today); s.setDate(s.getDate() - 7);
        return { start: s, label: 'in the last 7 days' };
    }
    if (windowKey === '30d') {
        const s = new Date(today); s.setDate(s.getDate() - 30);
        return { start: s, label: 'in the last 30 days' };
    }
    if (windowKey === 'ytd') {
        const s = new Date(today.getFullYear(), 0, 1);
        return { start: s, label: `year to date (since 1 Jan ${today.getFullYear()})` };
    }
    if (windowKey === 'install') {
        if (!config.borehole_started_at) return null;
        const s = new Date(config.borehole_started_at + 'T00:00:00');
        if (isNaN(s)) return null;
        const human = s.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        return { start: s, label: `since borehole install (${human})` };
    }
    return null;
}

// Sum the volume drawn by EXECUTED borehole waterings over the selected window
// and monetise it at the mains rate — that's the bill avoided.
async function loadSavings() {
    const bar = document.getElementById('savings-bar');
    const boreholeSerials = config.controllers
        .filter(c => (c.water_source || 'borehole') === 'borehole')
        .map(c => c.serial);

    if (!boreholeSerials.length) { bar.hidden = true; return; }

    const flow = config.default_zone_flow_lpm || config.borehole_capacity_lpm;
    if (!flow) { bar.hidden = true; return; }

    // Enable/disable the "Since install" button based on whether install date is set.
    const installBtn = document.querySelector('#savings-window [data-window="install"]');
    if (installBtn) {
        installBtn.disabled = !config.borehole_started_at;
        installBtn.title = config.borehole_started_at
            ? `Since ${new Date(config.borehole_started_at + 'T00:00:00').toLocaleDateString()}`
            : 'Set the install date in Settings to enable this';
    }

    let windowKey = loadSavingsWindow();
    let range = savingsRangeFor(windowKey);
    if (!range) { windowKey = '7d'; range = savingsRangeFor(windowKey); }

    document.querySelectorAll('#savings-window .range-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.window === windowKey);
    });

    const today = new Date();
    const startStr = toIsoDate(range.start);
    const endStr = toIsoDate(today);

    let totalLitres = 0;
    await Promise.all(boreholeSerials.map(async serial => {
        try {
            const schedules = await netro.schedules(serial, { start_date: startStr, end_date: endStr });
            for (const s of schedules) {
                if (s.status !== 'EXECUTED' && s.status !== 'EXECUTING') continue;
                const st = parseNetroTime(s.start_time);
                const en = parseNetroTime(s.end_time);
                const cutoff = en > today ? today : en;
                const durMin = Math.max(0, (cutoff - st) / 60000);
                totalLitres += durMin * flow;
            }
        } catch {}
    }));

    const ratePerM3 = config.mains_water_cost_per_m3 ?? 5;
    const cubicMetres = totalLitres / 1000;
    const cost = cubicMetres * ratePerM3;

    bar.hidden = false;
    document.getElementById('savings-since').textContent = range.label;
    document.getElementById('savings-rate').textContent = ratePerM3;
    document.getElementById('savings-amount').textContent = `£${cost.toFixed(2)}`;
    document.getElementById('savings-litres').textContent = `${Math.round(totalLitres).toLocaleString()} litres`;
}

document.querySelectorAll('#savings-window .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.disabled) return;
        saveSavingsWindow(btn.dataset.window);
        loadSavings();
    });
});

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

    // Prefer cached device info (set by loadControllers). On first paint the
    // cache may not be populated yet — fall back to fetching /info ourselves so
    // we always have zone names, then cache for subsequent refreshes.
    const all = await Promise.all(config.controllers.map(async c => {
        let info = dashboardControllerInfos.get(c.serial) || null;
        try {
            const tasks = [netro.schedules(c.serial, { start_date: startStr, end_date: endStr })];
            if (!info) tasks.push(netro.info(c.serial));
            const [scheds, fetchedInfo] = await Promise.all(tasks);
            if (fetchedInfo) {
                info = fetchedInfo;
                dashboardControllerInfos.set(c.serial, fetchedInfo);
            }
            return { cfg: c, info, scheds };
        } catch {
            return { cfg: c, info, scheds: [] };
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
            const tag = sourceTag(s.source);
            if (st <= now && en > now) {
                running.push({ cfg, zone: s.zone, zoneName, endMs: en, tag });
            } else if (st > now) {
                upcoming.push({ cfg, zone: s.zone, zoneName, startMs: st, durMs: en - st, tag });
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
            .map(r => `${r.cfg.nickname} · ${r.zoneName} ${r.tag} (${formatRemaining(r.endMs - now)} left)`)
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
        nextEl.textContent = `${u.cfg.nickname} · ${u.zoneName} ${u.tag} at ${startTime}${whenSuffix} (in ${formatRemaining(u.startMs - now)})`;
    }
}

// Convert Netro schedule source into a short tag. MANUAL = (M), anything else = (P).
function sourceTag(source) {
    return (source || '').toUpperCase() === 'MANUAL' ? '(M)' : '(P)';
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

// ---------- Sensor detail view (click sensor card) ----------
let currentSensorSerial = null;
let currentSensorRangeDays = 1;
let sensorCharts = []; // Chart.js instances we've spawned, so we can destroy on re-render

function openSensorDetail(serial) {
    currentSensorSerial = serial;
    location.hash = `sensor=${serial}`;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('sensor-detail').classList.add('active');
    loadSensorDetail(serial, currentSensorRangeDays);
}

function closeSensorDetail() {
    destroyCharts();
    if (location.hash.startsWith('#sensor=')) location.hash = '';
    switchTab('dashboard');
}

function destroyCharts() {
    sensorCharts.forEach(c => { try { c.destroy(); } catch {} });
    sensorCharts = [];
}

async function loadSensorDetail(serial, days) {
    const content = document.getElementById('sensor-detail-content');
    content.innerHTML = `<div class="loading">Loading…</div>`;
    destroyCharts();

    const cfg = config.sensors.find(s => s.serial === serial) || { serial, nickname: '' };
    document.getElementById('sensor-detail-name').textContent = cfg.nickname || serial;

    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - days);
    const startStr = toIsoDate(start);
    const endStr = toIsoDate(end);

    let info, data;
    try {
        [info, data] = await Promise.all([
            netro.sensorInfo(serial),
            netro.sensorData(serial, { start_date: startStr, end_date: endStr }),
        ]);
    } catch (e) {
        content.innerHTML = `<div class="placeholder">Failed to load: ${escapeHtml(e.message)}</div>`;
        return;
    }

    document.getElementById('sensor-detail-name').textContent = info.name || cfg.nickname || serial;
    const batteryPct = info.battery_level != null ? Math.round(info.battery_level * 100) : null;
    const meta = [
        serial,
        info.status ? info.status.toLowerCase() : '',
        batteryPct != null ? `battery ${batteryPct}%` : '',
        info.last_active ? `last seen ${formatAgo(info.last_active)}` : '',
    ].filter(Boolean).join(' · ');
    document.getElementById('sensor-detail-meta').textContent = meta;

    if (!data.length) {
        content.innerHTML = `<div class="placeholder">No readings in the last ${days} day${days > 1 ? 's' : ''}.</div>`;
        return;
    }

    // Sort ascending by time for charts.
    const sorted = [...data].sort((a, b) =>
        parseNetroTime(a.time).getTime() - parseNetroTime(b.time).getTime()
    );
    const latest = sorted[sorted.length - 1];

    const moistureSeries = sorted.map(d => ({ x: parseNetroTime(d.time), y: d.moisture }));
    const tempSeries = sorted
        .map(d => {
            const c = d.celsius != null ? d.celsius
                : (d.fahrenheit != null ? ((d.fahrenheit - 32) * 5 / 9) : null);
            return { x: parseNetroTime(d.time), y: c };
        })
        .filter(p => p.y != null);
    const lightSeries = sorted
        .filter(d => d.sunlight != null)
        .map(d => ({ x: parseNetroTime(d.time), y: +d.sunlight }));

    content.innerHTML = `
        ${chartCard('moisture-chart', 'Moisture',
            latest.moisture != null ? `${Math.round(latest.moisture)}%` : '—')}
        ${chartCard('temp-chart', 'Temperature',
            latest.celsius != null ? `${latest.celsius.toFixed(1)}°C` : '—')}
        ${chartCard('light-chart', 'Light',
            latest.sunlight != null ? (+latest.sunlight).toFixed(2) : '—')}
        ${renderThresholdPanel(cfg)}
        ${renderRulesPanel(cfg)}
    `;
    wireThresholdPanel(serial);
    wireRulesPanel(serial);

    sensorCharts.push(makeLineChart('moisture-chart', moistureSeries, {
        color: '#4cc2ff', yLabel: '%', yMin: 0, yMax: 100,
    }));
    sensorCharts.push(makeLineChart('temp-chart', tempSeries, {
        color: '#f6ad55', yLabel: '°C',
    }));
    sensorCharts.push(makeLineChart('light-chart', lightSeries, {
        color: '#f6e05e', yLabel: '',
    }));
}

function renderThresholdPanel(sensorCfg) {
    const m = sensorThresholds(sensorCfg, 'moisture');
    const b = sensorThresholds(sensorCfg, 'battery');
    return `
        <div class="chart-card threshold-panel">
            <h3>Alert thresholds for this sensor</h3>
            <p class="hint" style="margin-top:0;">
                The Moisture and Battery squares on the dashboard tint <span class="src-warn">red</span> below the
                warn threshold, <span style="color:var(--amber)">amber</span> between warn and good, and
                <span class="src-ok">green</span> at good or above.
            </p>
            <div class="threshold-grid">
                <div>
                    <div class="threshold-metric">Moisture</div>
                    <label class="field">
                        <span>Warn below (%)</span>
                        <input id="th-moisture-warn" type="number" min="0" max="100" step="1" value="${m.warn}">
                    </label>
                    <label class="field">
                        <span>Good at or above (%)</span>
                        <input id="th-moisture-good" type="number" min="0" max="100" step="1" value="${m.good}">
                    </label>
                </div>
                <div>
                    <div class="threshold-metric">Battery</div>
                    <label class="field">
                        <span>Warn below (%)</span>
                        <input id="th-battery-warn" type="number" min="0" max="100" step="1" value="${b.warn}">
                    </label>
                    <label class="field">
                        <span>Good at or above (%)</span>
                        <input id="th-battery-good" type="number" min="0" max="100" step="1" value="${b.good}">
                    </label>
                </div>
            </div>
            <div class="threshold-actions">
                <button class="btn-secondary" id="th-reset">Reset to defaults</button>
                <button class="btn-primary" id="th-save">Save thresholds</button>
            </div>
        </div>`;
}

function wireThresholdPanel(serial) {
    document.getElementById('th-save').addEventListener('click', async () => {
        const mw = parseFloat(document.getElementById('th-moisture-warn').value);
        const mg = parseFloat(document.getElementById('th-moisture-good').value);
        const bw = parseFloat(document.getElementById('th-battery-warn').value);
        const bg = parseFloat(document.getElementById('th-battery-good').value);
        if ([mw, mg, bw, bg].some(v => isNaN(v))) {
            toast('All four thresholds must be numbers', 'error');
            return;
        }
        if (mg < mw || bg < bw) {
            toast('"Good" threshold must be ≥ "warn" threshold', 'error');
            return;
        }
        const s = config.sensors.find(s => s.serial === serial);
        if (!s) return;
        s.thresholds = {
            moisture: { warn: mw, good: mg },
            battery:  { warn: bw, good: bg },
        };
        const result = await saveConfig(config);
        if (result.cloud === 'failed') {
            toast('Saved locally; cloud save failed: ' + result.error, 'error');
        } else {
            toast('Thresholds saved', 'success');
        }
        loadDashboard(); // re-tint sensor cards
    });

    document.getElementById('th-reset').addEventListener('click', async () => {
        const s = config.sensors.find(s => s.serial === serial);
        if (!s) return;
        delete s.thresholds;
        await saveConfig(config);
        loadSensorDetail(serial, currentSensorRangeDays); // re-render with defaults
        loadDashboard();
        toast('Reset to defaults', 'success');
    });
}

// ---------- Sensor-triggered irrigation rules ----------
function renderRulesPanel(sensorCfg) {
    const rules = Array.isArray(sensorCfg.rules) ? sensorCfg.rules : [];
    const rows = rules.map((r, i) => renderRuleRow(r, i)).join('') ||
        `<p class="hint">No rules yet. Click + Add rule below.</p>`;

    return `
        <div class="chart-card threshold-panel">
            <h3>Auto-trigger irrigation</h3>
            <p class="hint" style="margin-top:0;">
                When this sensor's reading crosses a threshold, automatically run the chosen zone.
                The Cloudflare Worker checks every 15 minutes. Use the cooldown to avoid back-to-back waterings.
            </p>
            <div id="rules-list">${rows}</div>
            <div class="threshold-actions">
                <button class="btn-secondary" id="add-rule">+ Add rule</button>
                <button class="btn-primary" id="save-rules">Save rules</button>
            </div>
        </div>`;
}

function renderRuleRow(r, i) {
    const controllerOpts = config.controllers.map(c =>
        `<option value="${escapeHtml(c.serial)}" ${c.serial === r.action?.controller_serial ? 'selected' : ''}>${escapeHtml(c.nickname || c.serial)}</option>`
    ).join('');

    const enabled = r.enabled !== false;
    const lastFired = r.last_triggered_at
        ? `last fired ${formatAgo(r.last_triggered_at)}`
        : 'never fired';

    // Backwards-compat: old single-zone rules used `action.zone` (number); new ones use `action.zones` (array).
    const selectedZones = Array.isArray(r.action?.zones)
        ? r.action.zones
        : (r.action?.zone ? [r.action.zone] : []);

    return `
        <div class="rule-row ${enabled ? '' : 'disabled'}" data-i="${i}">
            <div class="rule-when">
                <span class="rule-label">When</span>
                <select class="r-metric">
                    <option value="moisture" ${r.metric === 'moisture' ? 'selected' : ''}>Moisture (%)</option>
                    <option value="celsius" ${r.metric === 'celsius' ? 'selected' : ''}>Temperature (°C)</option>
                    <option value="sunlight" ${r.metric === 'sunlight' ? 'selected' : ''}>Light</option>
                </select>
                <select class="r-comp">
                    <option value="<" ${r.comparator !== '>' ? 'selected' : ''}>is below</option>
                    <option value=">" ${r.comparator === '>' ? 'selected' : ''}>is above</option>
                </select>
                <input class="r-threshold" type="number" step="0.1" value="${r.threshold ?? 25}" style="width:80px;">
            </div>
            <div class="rule-then">
                <span class="rule-label">then run on</span>
                <select class="r-controller">${controllerOpts}</select>
                <span class="rule-label">for</span>
                <input class="r-duration" type="number" min="1" max="240" value="${r.action?.duration_min ?? 10}" style="width:60px;">
                <span class="rule-label">min each · cooldown</span>
                <input class="r-cooldown" type="number" min="0" max="168" value="${r.cooldown_hours ?? 12}" style="width:60px;">
                <span class="rule-label">h</span>
            </div>
            <div class="rule-zones-wrap">
                <span class="rule-label">Zones (run sequentially, back-to-back):</span>
                <div class="rule-zones" data-selected='${JSON.stringify(selectedZones)}'>
                    ${renderRuleZoneCheckboxes(r.action?.controller_serial, selectedZones)}
                </div>
            </div>
            <div class="rule-meta">
                <label class="toggle">
                    <input class="r-enabled" type="checkbox" ${enabled ? 'checked' : ''}>
                    Enabled
                </label>
                <span class="hint" style="margin:0;">${lastFired}</span>
                <button class="btn-danger" data-remove-rule="${i}">Remove</button>
            </div>
        </div>`;
}

function renderRuleZoneCheckboxes(controllerSerial, selectedZones) {
    const info = dashboardControllerInfos.get(controllerSerial);
    if (!info?.zones) {
        return `<span class="hint" style="margin:0;">Pick a controller above to see its zones.</span>`;
    }
    const activeZones = info.zones.filter(z => z.enabled);
    if (!activeZones.length) {
        return `<span class="hint" style="margin:0;">No active zones on this controller.</span>`;
    }
    const sel = new Set(selectedZones || []);
    return activeZones.map(z => `
        <label class="zone-chip">
            <input type="checkbox" data-zone="${z.ith}" ${sel.has(z.ith) ? 'checked' : ''}>
            <span>${z.ith} · ${escapeHtml(z.name)}</span>
        </label>
    `).join('');
}

function wireRulesPanel(serial) {
    const list = document.getElementById('rules-list');

    document.getElementById('add-rule').addEventListener('click', () => {
        captureRulesToConfig(serial);
        const s = config.sensors.find(s => s.serial === serial);
        if (!s) return;
        s.rules = s.rules || [];
        s.rules.push({
            id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
            enabled: true,
            metric: 'moisture',
            comparator: '<',
            threshold: 25,
            action: {
                controller_serial: config.controllers[0]?.serial || '',
                zones: [],
                duration_min: 10,
            },
            cooldown_hours: 12,
            last_triggered_at: null,
        });
        loadSensorDetail(serial, currentSensorRangeDays);
    });

    // Re-render the zone checkbox grid when the controller changes for a row.
    list.querySelectorAll('.r-controller').forEach(sel => {
        sel.addEventListener('change', () => {
            const row = sel.closest('.rule-row');
            const wrap = row.querySelector('.rule-zones');
            wrap.innerHTML = renderRuleZoneCheckboxes(sel.value, []);
        });
    });

    list.querySelectorAll('[data-remove-rule]').forEach(b => {
        b.addEventListener('click', () => {
            captureRulesToConfig(serial);
            const s = config.sensors.find(s => s.serial === serial);
            if (!s?.rules) return;
            s.rules.splice(+b.dataset.removeRule, 1);
            loadSensorDetail(serial, currentSensorRangeDays);
        });
    });

    document.getElementById('save-rules').addEventListener('click', async () => {
        captureRulesToConfig(serial);
        const result = await saveConfig(config);
        if (result.cloud === 'failed') {
            toast('Saved locally; cloud save failed: ' + result.error, 'error');
        } else if (result.cloud === 'ok') {
            toast('Rules saved to the Worker', 'success');
        } else {
            toast('Rules saved locally (no Worker connected — rules only fire if the Worker is configured)', 'error');
        }
    });
}

function captureRulesToConfig(serial) {
    const s = config.sensors.find(s => s.serial === serial);
    if (!s) return;
    const rows = [...document.querySelectorAll('#rules-list .rule-row')];
    s.rules = rows.map((row, i) => {
        const existing = s.rules?.[i] || {};
        const checkedZones = [...row.querySelectorAll('.rule-zones input[type="checkbox"]:checked')]
            .map(cb => parseInt(cb.dataset.zone))
            .filter(n => !isNaN(n));
        return {
            id: existing.id || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
            enabled: row.querySelector('.r-enabled').checked,
            metric: row.querySelector('.r-metric').value,
            comparator: row.querySelector('.r-comp').value,
            threshold: parseFloat(row.querySelector('.r-threshold').value),
            action: {
                controller_serial: row.querySelector('.r-controller').value,
                zones: checkedZones,
                duration_min: parseInt(row.querySelector('.r-duration').value) || 10,
            },
            cooldown_hours: parseFloat(row.querySelector('.r-cooldown').value) || 0,
            last_triggered_at: existing.last_triggered_at || null,
        };
    });
}

function chartCard(canvasId, title, currentValue) {
    return `
        <div class="chart-card">
            <h3>${title}</h3>
            <div class="chart-current">${escapeHtml(currentValue)}</div>
            <div class="chart-wrap"><canvas id="${canvasId}"></canvas></div>
        </div>`;
}

function makeLineChart(canvasId, points, { color, yLabel, yMin, yMax }) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const textDim = cssVar('--text-dim') || '#8b98a5';
    const border = cssVar('--border') || '#2a3441';
    return new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                data: points,
                borderColor: color,
                backgroundColor: color + '22',
                fill: true,
                tension: 0.25,
                pointRadius: 2,
                pointHoverRadius: 4,
                borderWidth: 2,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    type: 'time',
                    time: { tooltipFormat: 'PPpp' },
                    grid: { color: border, drawBorder: false },
                    ticks: { color: textDim, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
                },
                y: {
                    title: yLabel ? { display: true, text: yLabel, color: textDim } : { display: false },
                    grid: { color: border, drawBorder: false },
                    ticks: { color: textDim },
                    min: yMin,
                    max: yMax,
                },
            },
        },
    });
}

document.getElementById('sensor-detail-back').addEventListener('click', closeSensorDetail);

document.querySelectorAll('#sensor-detail-range .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#sensor-detail-range .range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSensorRangeDays = +btn.dataset.days;
        if (currentSensorSerial) loadSensorDetail(currentSensorSerial, currentSensorRangeDays);
    });
});

// Deep link via URL hash: #sensor=SERIAL opens that sensor's detail on load.
window.addEventListener('hashchange', () => {
    const m = location.hash.match(/^#sensor=([0-9a-f]+)$/i);
    if (m) openSensorDetail(m[1]);
});

// ---------- Auto-refresh timers ----------
// Both run only when the Dashboard tab is active AND the browser tab is visible.
// Status bar: every 60s (running/next is time-sensitive).
// Sensors: every 15min (sensors only upload ~hourly anyway).
// Both also refresh instantly when the browser tab becomes visible after being hidden.
let statusBarTimer = null;
let sensorsTimer = null;
const STATUS_REFRESH_MS = 60_000;
const SENSORS_REFRESH_MS = 15 * 60_000;

// ---------- History tab ----------
let historyRangeDays = 7;

document.querySelectorAll('#history-range .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#history-range .range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        historyRangeDays = +btn.dataset.days;
        loadHistory();
    });
});

async function loadHistory() {
    const container = document.getElementById('history-content');
    if (!hasController(config)) {
        container.innerHTML = `<div class="placeholder">Add a controller in Settings first.</div>`;
        return;
    }

    container.innerHTML = `<div class="loading">Loading…</div>`;

    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - historyRangeDays);
    const startStr = toIsoDate(start);
    const endStr = toIsoDate(end);

    // Pull the Worker's watering log in parallel — we use it to tag rows as
    // sensor-rule / daily-cron vs generic manual.
    const wateringLog = await fetchWateringLog().catch(() => []);

    const allRuns = [];
    await Promise.all(config.controllers.map(async c => {
        let info = dashboardControllerInfos.get(c.serial);
        if (!info) {
            try {
                info = await netro.info(c.serial);
                dashboardControllerInfos.set(c.serial, info);
            } catch {}
        }
        try {
            const schedules = await netro.schedules(c.serial, { start_date: startStr, end_date: endStr });
            for (const s of schedules) {
                if (s.status !== 'EXECUTED' && s.status !== 'EXECUTING') continue;
                const st = parseNetroTime(s.start_time);
                const en = parseNetroTime(s.end_time);
                const zoneName = info?.zones?.find(z => z.ith === s.zone)?.name || `Zone ${s.zone}`;
                const logHit = matchLog(wateringLog, c.serial, s.zone, st.getTime());
                allRuns.push({
                    startMs: st.getTime(),
                    endMs: en.getTime(),
                    controller: c.nickname || info?.name || c.serial,
                    zone: s.zone,
                    zoneName,
                    source: s.source || '',
                    origin: logHit?.origin || null,
                    originMeta: logHit || null,
                });
            }
        } catch {}
    }));

    if (!allRuns.length) {
        container.innerHTML = `<div class="placeholder">No waterings in the last ${historyRangeDays} days.</div>`;
        return;
    }

    allRuns.sort((a, b) => b.startMs - a.startMs);

    const total = allRuns.length;
    const totalMin = Math.round(allRuns.reduce((n, r) => n + (r.endMs - r.startMs) / 60000, 0));
    const totalHr = Math.floor(totalMin / 60);
    const totalRem = totalMin % 60;
    const totalLabel = totalHr ? `${totalHr}h ${totalRem}m` : `${totalRem}m`;

    container.innerHTML = `
        <div class="history-summary">
            ${total} watering${total > 1 ? 's' : ''} · total run time ${totalLabel}
        </div>
        <div class="history-table">
            <div class="history-row history-head">
                <span>When</span>
                <span>Controller</span>
                <span>Zone</span>
                <span>Duration</span>
                <span>Source</span>
            </div>
            ${allRuns.map(renderHistoryRow).join('')}
        </div>`;
}

async function fetchWateringLog() {
    const creds = loadWorkerCreds();
    if (!creds.url || !creds.token) return [];
    const r = await fetch(`${creds.url}/watering-log`, { headers: { Authorization: `Bearer ${creds.token}` } });
    if (!r.ok) return [];
    return r.json();
}

// Match a Netro schedule entry against a Worker log entry by serial + zone + approximate start time.
function matchLog(log, serial, zone, startMs) {
    const TOLERANCE_MS = 5 * 60_000; // 5 minutes
    return log.find(entry => {
        if (entry.serial !== serial) return false;
        if (entry.zone !== zone) return false;
        const logMs = new Date(entry.start_time).getTime();
        return Math.abs(logMs - startMs) <= TOLERANCE_MS;
    });
}

function renderHistoryRow(r) {
    const start = new Date(r.startMs);
    const today = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const runDay = new Date(r.startMs); runDay.setHours(0,0,0,0);

    let dayLabel;
    if (+runDay === +today) dayLabel = 'Today';
    else if (+runDay === +yesterday) dayLabel = 'Yesterday';
    else dayLabel = start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    const timeLabel = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    const durMin = Math.round((r.endMs - r.startMs) / 60000);

    // Resolve the source pill: prefer the Worker-tagged origin, fall back to Netro's source field.
    const isNetroManual = (r.source || '').toUpperCase() === 'MANUAL';
    let pillClass, pillLabel, pillTitle = '';
    if (r.origin === 'sensor-rule') {
        pillClass = 'sensor';
        pillLabel = 'Sensor';
        const m = r.originMeta;
        if (m) {
            const sensorCfg = config.sensors.find(s => s.serial === m.sensor_serial);
            const sensorName = sensorCfg?.nickname || m.sensor_serial;
            const valueDisplay = m.reading_value != null ? Math.round(m.reading_value * 10) / 10 : '—';
            pillTitle = `Triggered by ${sensorName} · ${m.metric}=${valueDisplay}`;
        }
    } else if (r.origin === 'daily-cron') {
        pillClass = 'cron';
        pillLabel = 'Cron';
        pillTitle = 'Pushed by the daily recurring-pattern cron';
    } else if (isNetroManual) {
        pillClass = 'manual';
        pillLabel = 'Manual';
        pillTitle = 'Manually started from the app or Netro mobile';
    } else {
        pillClass = 'program';
        pillLabel = 'Program';
        pillTitle = 'Run by the Netro on-device smart schedule';
    }

    return `
        <div class="history-row">
            <span><span class="hist-day">${dayLabel}</span> <span class="hist-time">${timeLabel}</span></span>
            <span>${escapeHtml(r.controller)}</span>
            <span>${r.zone} · ${escapeHtml(r.zoneName)}</span>
            <span>${durMin} min</span>
            <span class="src-pill ${pillClass}" title="${escapeHtml(pillTitle)}">${pillLabel}</span>
        </div>`;
}

function isDashboardActiveAndVisible() {
    return document.visibilityState === 'visible'
        && document.getElementById('dashboard').classList.contains('active');
}

function isStatusViewActiveAndVisible() {
    return document.visibilityState === 'visible'
        && (document.getElementById('dashboard').classList.contains('active')
         || document.getElementById('timeline').classList.contains('active'));
}

function shouldRefreshStatusBar() {
    return isStatusViewActiveAndVisible() && hasController(config);
}

function shouldRefreshSensors() {
    return isDashboardActiveAndVisible() && hasSensor(config);
}

function startAutoRefreshTimers() {
    if (statusBarTimer) clearInterval(statusBarTimer);
    if (sensorsTimer) clearInterval(sensorsTimer);
    statusBarTimer = setInterval(() => {
        if (shouldRefreshStatusBar()) loadStatusBar().catch(() => {});
    }, STATUS_REFRESH_MS);
    sensorsTimer = setInterval(() => {
        if (shouldRefreshSensors()) loadSensors().catch(() => {});
    }, SENSORS_REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
    if (shouldRefreshStatusBar()) loadStatusBar().catch(() => {});
    if (shouldRefreshSensors()) loadSensors().catch(() => {});
});

startAutoRefreshTimers();

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
            dashboardControllerInfos.set(c.serial, info);
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
            const latest = pickLatestReading(dataArr);
            return renderSensorCard(s, info, latest, null);
        } catch (e) {
            return renderSensorCard(s, null, null, e.message);
        }
    }));

    grid.innerHTML = cards.join('');
    document.querySelectorAll('.sensor-card[data-sensor-serial]').forEach(card => {
        card.addEventListener('click', () => openSensorDetail(card.dataset.sensorSerial));
    });
}

// Netro returns sensor_data sorted newest-first, but be defensive — sort by time
// descending and take the head so we don't depend on response order.
function pickLatestReading(dataArr) {
    if (!Array.isArray(dataArr) || dataArr.length === 0) return null;
    const sorted = [...dataArr].sort((a, b) =>
        parseNetroTime(b.time).getTime() - parseNetroTime(a.time).getTime()
    );
    return sorted[0];
}

function renderSensorCard(cfg, info, latest, errorMsg) {
    const name = info?.name || cfg.nickname || 'Sensor';

    if (errorMsg) {
        return `
            <div class="sensor-card" data-sensor-serial="${escapeHtml(cfg.serial)}">
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
    const batteryThresholds = sensorThresholds(cfg, 'battery');
    const batteryCls = thresholdClass(batteryPct, batteryThresholds);
    const batteryDisplay = batteryPct != null ? `${batteryPct}%` : '—';

    const moistureVal = latest?.moisture;
    const moistureThresholds = sensorThresholds(cfg, 'moisture');
    const moistureCls = thresholdClass(moistureVal, moistureThresholds);
    const moistureDisplay = moistureVal != null ? `${Math.round(moistureVal)}%` : '—';

    const temp = latest?.celsius != null
        ? `${latest.celsius.toFixed(1)}°C`
        : (latest?.fahrenheit != null ? `${(((latest.fahrenheit - 32) * 5) / 9).toFixed(1)}°C` : '—');
    const light = latest?.sunlight != null ? `${(+latest.sunlight).toFixed(2)}` : '—';

    const lastSeen = info.last_active ? formatAgo(info.last_active) : 'never';

    return `
        <div class="sensor-card" data-sensor-serial="${escapeHtml(cfg.serial)}">
            <div class="sensor-card-header">
                <div>
                    <h3 class="sensor-name">${escapeHtml(name)}</h3>
                    <div class="sensor-serial">${escapeHtml(cfg.serial)}</div>
                </div>
                <span class="status-pill ${statusClass}">${statusText}</span>
            </div>
            <div class="sensor-metrics">
                <div class="metric ${moistureCls}">
                    <div class="metric-label">Moisture</div>
                    <div class="metric-value ${moistureCls}">${moistureDisplay}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Temperature</div>
                    <div class="metric-value">${temp}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Light</div>
                    <div class="metric-value">${light}</div>
                </div>
                <div class="metric ${batteryCls}">
                    <div class="metric-label">Battery</div>
                    <div class="metric-value ${batteryCls}">${batteryDisplay}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Last seen</div>
                    <div class="metric-value" style="font-size:13px;">${lastSeen}</div>
                </div>
            </div>
            <div class="open-hint">click for history →</div>
        </div>`;
}

// Returns 'good' | 'warn' | 'bad' | '' for a numeric value against ascending thresholds.
// e.g. thresholdClass(25, { good: 35, warn: 20 }) → 'warn' (25 is between 20 and 35).
function thresholdClass(value, { good, warn }) {
    if (value == null || isNaN(value)) return '';
    if (value >= good) return 'good';
    if (value >= warn) return 'warn';
    return 'bad';
}

// Resolve a sensor's threshold preferences for a given metric.
// Reads from sensor config if set, otherwise returns sensible defaults.
const DEFAULT_THRESHOLDS = {
    moisture: { warn: 20, good: 35 },
    battery:  { warn: 20, good: 50 },
};

function sensorThresholds(sensorCfg, metric) {
    const fromCfg = sensorCfg?.thresholds?.[metric];
    const def = DEFAULT_THRESHOLDS[metric];
    return {
        warn: fromCfg?.warn ?? def.warn,
        good: fromCfg?.good ?? def.good,
    };
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
                    <h3 class="controller-name">${escapeHtml(info.name || cfg.nickname)}</h3>
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
    document.getElementById('mains-lpm').value = config.mains_capacity_lpm ?? '';
    document.getElementById('default-zone-flow').value = config.default_zone_flow_lpm ?? '';
    document.getElementById('mains-cost').value = config.mains_water_cost_per_m3 ?? '';
    document.getElementById('borehole-started').value = config.borehole_started_at ?? '';

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
    list.innerHTML = items.map((c, i) => {
        const sourceSelect = kind === 'controller' ? `
            <label class="field">
                <span>Water source</span>
                <select class="ec-source-controller">
                    <option value="borehole" ${(c.water_source || 'borehole') === 'borehole' ? 'selected' : ''}>Borehole</option>
                    <option value="mains" ${c.water_source === 'mains' ? 'selected' : ''}>Mains</option>
                </select>
            </label>` : '';
        return `
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
                ${sourceSelect}
                <button class="btn-danger" data-remove="${i}">Remove</button>
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-remove]').forEach(b => {
        b.addEventListener('click', () => onRemove(+b.dataset.remove));
    });
}

function captureSettingsToConfig() {
    const cNicks = [...document.querySelectorAll('.ec-nick-controller')];
    const cSerials = [...document.querySelectorAll('.ec-serial-controller')];
    const cSources = [...document.querySelectorAll('.ec-source-controller')];
    config.controllers = cNicks.map((n, i) => ({
        serial: cSerials[i].value.trim().toLowerCase(),
        nickname: n.value.trim() || 'Controller',
        zone_flow_lpm: config.controllers[i]?.zone_flow_lpm ?? {},
        water_source: cSources[i]?.value || 'borehole',
    }));

    const sNicks = [...document.querySelectorAll('.ec-nick-sensor')];
    const sSerials = [...document.querySelectorAll('.ec-serial-sensor')];
    config.sensors = sNicks.map((n, i) => ({
        serial: sSerials[i].value.trim().toLowerCase(),
        nickname: n.value.trim(),
    }));

    const bh = document.getElementById('borehole-lpm').value;
    config.borehole_capacity_lpm = bh ? parseFloat(bh) : null;
    const mn = document.getElementById('mains-lpm').value;
    config.mains_capacity_lpm = mn ? parseFloat(mn) : null;
    const dz = document.getElementById('default-zone-flow').value;
    config.default_zone_flow_lpm = dz ? parseFloat(dz) : null;
    const mc = document.getElementById('mains-cost').value;
    config.mains_water_cost_per_m3 = mc ? parseFloat(mc) : 5;
    const bs = document.getElementById('borehole-started').value;
    config.borehole_started_at = bs || null;
}

document.getElementById('add-controller').addEventListener('click', () => {
    captureSettingsToConfig();
    config.controllers.push({ serial: '', nickname: '', zone_flow_lpm: {} });
    renderSettings();
});

document.getElementById('pull-names').addEventListener('click', async () => {
    captureSettingsToConfig();
    if (!hasController(config) && !hasSensor(config)) {
        toast('Add a serial first.', 'error');
        return;
    }

    const status = document.getElementById('save-status');
    status.textContent = 'Pulling names from Netro…';

    let changed = 0;
    const failures = [];

    await Promise.all([
        ...config.controllers.map(async c => {
            if (!c.serial) return;
            try {
                const info = await netro.info(c.serial);
                if (info?.name && info.name !== c.nickname) {
                    c.nickname = info.name;
                    changed++;
                }
            } catch (e) { failures.push(`${c.serial}: ${e.message}`); }
        }),
        ...config.sensors.map(async s => {
            if (!s.serial) return;
            try {
                const info = await netro.sensorInfo(s.serial);
                if (info?.name && info.name !== s.nickname) {
                    s.nickname = info.name;
                    changed++;
                }
            } catch (e) { failures.push(`${s.serial}: ${e.message}`); }
        }),
    ]);

    renderSettings();
    status.textContent = '';
    if (failures.length) {
        toast(`Pulled ${changed}; ${failures.length} failed`, 'error');
    } else {
        toast(changed ? `Updated ${changed} name${changed > 1 ? 's' : ''}. Hit Save to keep.` : 'All names already matched Netro.', 'success');
    }
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

    status.textContent = 'Saving…';
    const result = await saveConfig(config);
    if (result.cloud === 'ok') {
        configSource = 'cloud';
        status.textContent = failures.length ? 'Saved to cloud (with warnings)' : 'Saved to cloud';
    } else if (result.cloud === 'failed') {
        status.textContent = 'Saved locally — cloud failed';
        toast('Cloud save failed: ' + result.error, 'error');
    } else {
        status.textContent = failures.length ? 'Saved with warnings' : 'Saved';
    }
    updateSyncBadge();
    if (failures.length) {
        toast('Saved, but some devices failed: ' + failures.join('; '), 'error');
    } else if (result.cloud !== 'failed') {
        toast('Settings saved', 'success');
    }
    setTimeout(() => status.textContent = '', 3000);
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
(async () => {
    await initConfig();
    // Honour a sensor deep link if the user opened the URL with #sensor=…
    const m = location.hash.match(/^#sensor=([0-9a-f]+)$/i);
    if (m && hasController(config)) {
        loadDashboard();
        openSensorDetail(m[1]);
    } else if (!hasController(config)) {
        switchTab('settings');
        loadDashboard();
    } else {
        loadDashboard();
    }
})();
