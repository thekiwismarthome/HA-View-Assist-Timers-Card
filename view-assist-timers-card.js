/**
 * View Assist Timers Card
 * Shows all active timers, alarms, and reminders from the View Assist integration.
 *
 * Usage in Lovelace YAML:
 *   type: custom:view-assist-timers-card
 *   title: Timers, Alarms & Reminders   # optional, set to '' to hide
 *   show_types:                          # optional, default: all three
 *     - timer
 *     - alarm
 *     - reminder
 *   refresh_interval: 5                  # seconds between API polls, default 5
 *   snooze_time: "10 minutes"            # snooze duration, default "10 minutes"
 *
 * Installation: copy to config/www/ and add to Lovelace resources:
 *   url: /local/view-assist-timers-card.js
 *   type: module
 */

class ViewAssistTimersCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._timers = [];
    this._loading = true;
    this._error = null;
    this._refreshInterval = null;
    this._tickInterval = null;
    this._finishTimes = {};
  }

  static getStubConfig() {
    return { title: 'Timers, Alarms & Reminders' };
  }

  setConfig(config) {
    this._config = {
      title: 'title' in config ? config.title : 'Timers, Alarms & Reminders',
      show_types: config.show_types || ['timer', 'alarm', 'reminder'],
      refresh_interval: (config.refresh_interval ?? 5) * 1000,
      snooze_time: config.snooze_time || '10 minutes',
    };
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._fetchTimers();
      this._refreshInterval = setInterval(() => this._fetchTimers(), this._config.refresh_interval);
      this._tickInterval = setInterval(() => this._tickCountdowns(), 1000);
    }
  }

  disconnectedCallback() {
    clearInterval(this._refreshInterval);
    clearInterval(this._tickInterval);
    this._refreshInterval = null;
    this._tickInterval = null;
  }

  // ── Data fetching ──────────────────────────────────────────────────────────

  async _fetchTimers() {
    if (!this._hass) return;
    try {
      const wsResult = await this._hass.callWS({
        type: 'call_service',
        domain: 'view_assist',
        service: 'get_timers',
        service_data: {},
        return_response: true,
      });
      const fetchedAt = Date.now();
      // VA returns result at response.result; fall back to result directly
      const raw = wsResult?.response?.result ?? wsResult?.result ?? wsResult ?? [];
      this._timers = Array.isArray(raw) ? raw : [];
      this._loading = false;
      this._error = null;
      this._updateFinishTimes(fetchedAt);
    } catch (err) {
      this._loading = false;
      this._error = 'View Assist unavailable';
      console.error('[view-assist-timers-card]', err);
    }
    this._render();
  }

  _updateFinishTimes(fetchedAt) {
    // Remove stale entries for timers no longer in the list
    const activeIds = new Set(this._timers.map(t => t.id));
    Object.keys(this._finishTimes).forEach(id => {
      if (!activeIds.has(id)) delete this._finishTimes[id];
    });
    // Refresh finish time for every active timer on each fetch
    this._timers.forEach(t => {
      const ft = this._parseFinishTime(t, fetchedAt);
      if (ft) this._finishTimes[t.id] = ft;
    });
  }

  _parseFinishTime(timer, fetchedAt) {
    // Absolute timestamp fields (ISO string or epoch seconds/ms)
    for (const key of ['finish_time', 'end_time', 'expiry_time', 'due_time']) {
      const val = timer[key];
      if (val == null) continue;
      const ts = typeof val === 'number'
        ? (val > 1e10 ? val : val * 1000)   // epoch seconds vs ms
        : new Date(val).getTime();
      if (!isNaN(ts)) return ts;
    }
    if (timer.expiry?.timestamp) {
      const ts = new Date(timer.expiry.timestamp).getTime();
      if (!isNaN(ts)) return ts;
    }
    // Relative seconds-remaining fields
    for (const key of ['seconds_remaining', 'remaining_seconds', 'remaining']) {
      if (timer[key] != null) return fetchedAt + Number(timer[key]) * 1000;
    }
    if (timer.expiry?.seconds_remaining != null) {
      return fetchedAt + Number(timer.expiry.seconds_remaining) * 1000;
    }
    return null;
  }

  // ── Countdown ──────────────────────────────────────────────────────────────

  _getCountdown(timer) {
    const ft = this._finishTimes[timer.id];
    if (ft != null) {
      const secs = Math.max(0, Math.floor((ft - Date.now()) / 1000));
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    // Fall back to the text the API provides
    return timer.expiry?.text || timer.duration || '—';
  }

  _tickCountdowns() {
    if (!this.shadowRoot || this._timers.length === 0) return;
    this.shadowRoot.querySelectorAll('[data-timer-id]').forEach(el => {
      const timer = this._timers.find(t => t.id === el.dataset.timerId);
      if (timer) el.textContent = this._getCountdown(timer);
    });
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async _cancelTimer(id) {
    try {
      await this._hass.callService('view_assist', 'cancel_timer', { timer_id: id });
    } catch (e) {
      console.error('[view-assist-timers-card] cancel_timer failed', e);
    }
    delete this._finishTimes[id];
    setTimeout(() => this._fetchTimers(), 700);
  }

  async _snoozeTimer(id) {
    try {
      await this._hass.callService('view_assist', 'snooze_timer', {
        timer_id: id,
        time: this._config.snooze_time,
      });
    } catch (e) {
      console.error('[view-assist-timers-card] snooze_timer failed', e);
    }
    setTimeout(() => this._fetchTimers(), 700);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _render() {
    if (!this.shadowRoot) return;

    const { show_types, title } = this._config;

    const active = this._timers.filter(
      t => show_types.includes(t.timer_class) && t.status !== 'expired'
    );

    const groups = {
      timer:    active.filter(t => t.timer_class === 'timer'),
      alarm:    active.filter(t => t.timer_class === 'alarm'),
      reminder: active.filter(t => t.timer_class === 'reminder'),
    };

    const META = {
      timer:    { icon: 'mdi:timer-outline', label: 'Timers',    color: '#039be5' },
      alarm:    { icon: 'mdi:alarm',         label: 'Alarms',    color: '#e53935' },
      reminder: { icon: 'mdi:reminder',      label: 'Reminders', color: '#fb8c00' },
    };

    const bodyHtml = (() => {
      if (this._loading) {
        return `<div class="state-msg">
          <ha-circular-progress active indeterminate></ha-circular-progress>
        </div>`;
      }
      if (this._error) {
        return `<div class="state-msg error">
          <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
          ${this._error}
        </div>`;
      }
      if (active.length === 0) {
        return `<div class="state-msg muted">
          <ha-icon icon="mdi:check-circle-outline"></ha-icon>
          No active timers, alarms, or reminders
        </div>`;
      }
      return Object.entries(groups)
        .filter(([cls, items]) => items.length > 0 && show_types.includes(cls))
        .map(([cls, items]) => {
          const meta = META[cls];
          return `<div class="section">
            <div class="section-header" style="color:${meta.color}">
              <ha-icon icon="${meta.icon}" style="color:${meta.color}"></ha-icon>
              <span>${meta.label}</span>
            </div>
            ${items.map(t => this._rowHtml(t, meta)).join('')}
          </div>`;
        }).join('');
    })();

    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <ha-card>
        ${title !== ''
          ? `<div class="card-header">
               <ha-icon icon="mdi:bell-ring-outline"></ha-icon>
               <span>${title}</span>
             </div>`
          : ''}
        <div class="card-body">${bodyHtml}</div>
      </ha-card>`;

    this.shadowRoot.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const { action, id } = e.currentTarget.dataset;
        if (action === 'cancel' || action === 'dismiss') this._cancelTimer(id);
        else if (action === 'snooze') this._snoozeTimer(id);
      });
    });
  }

  _rowHtml(timer, meta) {
    const isRinging = timer.status === 'ringing';
    const name = timer.name || timer.extra_info?.sentence || timer.duration || timer.timer_class;

    const actions = isRinging
      ? `<button class="btn btn-snooze" data-action="snooze" data-id="${timer.id}">Snooze</button>
         <button class="btn btn-dismiss" data-action="dismiss" data-id="${timer.id}">Dismiss</button>`
      : `<button class="btn btn-cancel" data-action="cancel" data-id="${timer.id}" title="Cancel">
           <ha-icon icon="mdi:close"></ha-icon>
         </button>`;

    return `
      <div class="timer-row${isRinging ? ' ringing' : ''}">
        <div class="timer-icon" style="background:${meta.color}22">
          <ha-icon icon="${meta.icon}" style="color:${meta.color}"></ha-icon>
        </div>
        <div class="timer-info">
          <div class="timer-name" title="${name}">${name}</div>
          <div class="timer-countdown" style="color:${meta.color}" data-timer-id="${timer.id}">
            ${this._getCountdown(timer)}
          </div>
        </div>
        <div class="timer-actions">${actions}</div>
      </div>`;
  }

  _css() {
    return `
      :host { display: block; }
      ha-card { overflow: hidden; }

      .card-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 16px 10px;
        font-size: 1.05em;
        font-weight: 500;
        color: var(--primary-text-color);
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.12));
      }
      .card-header ha-icon {
        color: var(--primary-color);
        --mdc-icon-size: 20px;
      }

      .card-body { padding: 6px 0 8px; }

      .section { padding: 2px 0; }

      .section-header {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 6px 16px 3px;
        font-size: 0.7em;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.09em;
      }
      .section-header ha-icon { --mdc-icon-size: 13px; }

      .timer-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 12px;
        margin: 1px 6px;
        border-radius: 8px;
        transition: background 0.15s;
      }
      .timer-row:hover { background: var(--secondary-background-color); }

      .ringing { animation: pulse 1.2s ease-in-out infinite; }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.5; }
      }

      .timer-icon {
        flex-shrink: 0;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .timer-icon ha-icon { --mdc-icon-size: 20px; }

      .timer-info {
        flex: 1;
        min-width: 0;
      }
      .timer-name {
        font-size: 0.85em;
        color: var(--secondary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
        text-transform: capitalize;
      }
      .timer-countdown {
        font-size: 1.3em;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        line-height: 1.25;
      }

      .timer-actions {
        flex-shrink: 0;
        display: flex;
        gap: 5px;
        align-items: center;
      }

      .btn {
        border: none;
        border-radius: 6px;
        padding: 5px 12px;
        font-size: 0.78em;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: filter 0.15s;
        font-family: inherit;
      }
      .btn:hover { filter: brightness(1.12); }
      .btn:active { filter: brightness(0.92); }

      .btn-cancel {
        background: var(--secondary-background-color, rgba(0,0,0,.06));
        color: var(--secondary-text-color);
        padding: 5px 7px;
      }
      .btn-cancel ha-icon { --mdc-icon-size: 17px; }

      .btn-dismiss {
        background: #e53935;
        color: #fff;
      }
      .btn-snooze {
        background: #fb8c00;
        color: #fff;
      }

      .state-msg {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 28px 16px;
        text-align: center;
        font-size: 0.9em;
        color: var(--secondary-text-color);
      }
      .state-msg ha-icon { --mdc-icon-size: 32px; opacity: 0.5; }
      .state-msg.error { color: var(--error-color, #e53935); }
      .state-msg.error ha-icon { opacity: 0.8; }
    `;
  }
}

if (!customElements.get('view-assist-timers-card')) {
  customElements.define('view-assist-timers-card', ViewAssistTimersCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.find(c => c.type === 'view-assist-timers-card')) {
  window.customCards.push({
    type: 'view-assist-timers-card',
    name: 'View Assist Timers Card',
    description: 'Shows active timers, alarms, and reminders from View Assist',
    preview: false,
  });
}
