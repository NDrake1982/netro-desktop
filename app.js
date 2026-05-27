import { netro } from './netro.js';
import { loadConfig, saveConfig, hasController, defaultConfig } from './config.js';

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
    } catch (e) {
        toast('Failed to load: ' + e.message, 'error');
    } finally {
        refresh.classList.remove('spinning');
    }
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

    const list = document.getElementById('controller-edit-list');
    if (!config.controllers.length) {
        list.innerHTML = `<p class="hint" style="color:var(--text-dim);">No controllers added yet. Click + Add controller below.</p>`;
        return;
    }
    list.innerHTML = config.controllers.map((c, i) => `
        <div class="controller-edit-row" data-i="${i}">
            <div class="row-head">
                <label class="field">
                    <span>Nickname</span>
                    <input class="ec-nick" type="text" value="${escapeHtml(c.nickname || '')}" placeholder="e.g. Cart Lodge">
                </label>
                <label class="field">
                    <span>Serial number</span>
                    <input class="ec-serial" type="text" value="${escapeHtml(c.serial || '')}" placeholder="12-char hex">
                </label>
                <button class="btn-danger" data-remove="${i}">Remove</button>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('[data-remove]').forEach(b => {
        b.addEventListener('click', () => {
            const i = +b.dataset.remove;
            // First write current input values into config so we don't lose unsaved edits.
            captureSettingsToConfig();
            config.controllers.splice(i, 1);
            renderSettings();
        });
    });
}

function captureSettingsToConfig() {
    const nicks = [...document.querySelectorAll('.ec-nick')];
    const serials = [...document.querySelectorAll('.ec-serial')];
    config.controllers = nicks.map((n, i) => ({
        serial: serials[i].value.trim().toLowerCase(),
        nickname: n.value.trim() || 'Controller',
        zone_flow_lpm: config.controllers[i]?.zone_flow_lpm ?? {},
    }));
    const bh = document.getElementById('borehole-lpm').value;
    config.borehole_capacity_lpm = bh ? parseFloat(bh) : null;
}

document.getElementById('add-controller').addEventListener('click', () => {
    captureSettingsToConfig();
    config.controllers.push({ serial: '', nickname: '', zone_flow_lpm: {} });
    renderSettings();
});

document.getElementById('save-config').addEventListener('click', async () => {
    captureSettingsToConfig();

    // Drop rows without a serial.
    config.controllers = config.controllers.filter(c => c.serial);

    const status = document.getElementById('save-status');
    status.textContent = 'Validating…';

    // Quick validation: try to fetch info for each controller; flag any that fail.
    const failures = [];
    for (const c of config.controllers) {
        try {
            await netro.info(c.serial);
        } catch (e) {
            failures.push(`${c.nickname || c.serial}: ${e.message}`);
        }
    }

    saveConfig(config);
    status.textContent = failures.length ? 'Saved with warnings' : 'Saved';
    if (failures.length) {
        toast('Saved, but some controllers failed: ' + failures.join('; '), 'error');
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
