# View Assist Timers Card

A Home Assistant Lovelace custom card that displays all active timers, alarms, and reminders from the [View Assist](https://github.com/dinki/view-assist) integration. Supports real-time countdowns, progress indicators, a ringing popup overlay, and full visual configuration via the HA card editor.

---

## Installation

1. Copy `view-assist-timers-card.js` to your Home Assistant `config/www/` directory.
2. Add it as a Lovelace resource:

```yaml
resources:
  - url: /local/view-assist-timers-card.js
    type: module
```

3. Add the card to a dashboard:

```yaml
type: custom:view-assist-timers-card
```

---

## Visual Editor

All options can be configured through the built-in card editor — click the pencil icon on the card in your dashboard. No YAML editing required.

---

## Configuration Options

| Option | Default | Description |
|---|---|---|
| `title` | `Timers, Alarms & Reminders` | Card header text. Set to `''` to hide the header. |
| `show_types` | `[timer, alarm, reminder]` | Which types to display. |
| `display_mode` | `bar` | `bar` — list rows with a linear progress bar. `horseshoe` — tile grid with a circular arc. |
| `columns` | `2` | Tiles per row in horseshoe mode. |
| `max_height` | `0` | Maximum card body height in px before it scrolls. `0` = no limit. |
| `hide_when_empty` | `false` | Collapse the card entirely when there are no active timers/alarms/reminders. |
| `show_ringing_popup` | `true` | Show a floating popup overlay when an alarm is ringing. |
| `popup_movable` | `true` | Allow the ringing popup to be dragged around the screen. |
| `snooze_options` | `[5, 10]` | Snooze durations (minutes) offered in the ringing popup and on ringing rows. |
| `refresh_interval` | `5` | Seconds between API polls. |

### Example YAML

```yaml
type: custom:view-assist-timers-card
title: "Timers, Alarms & Reminders"
display_mode: horseshoe
columns: 3
max_height: 400
hide_when_empty: true
show_ringing_popup: true
popup_movable: true
snooze_options:
  - 5
  - 10
  - 15
refresh_interval: 5
show_types:
  - timer
  - alarm
  - reminder
```

---

## Features

### Display Modes

**Bar mode** (default)

Timers are shown as a grouped list. Each row has a type icon, the timer name, a live countdown, and a thin progress bar that fills as time elapses. When a timer is ringing the bar flashes at full width.

**Horseshoe mode**

Each timer is shown as a tile containing a 270° SVG arc progress indicator. The arc fills clockwise as time elapses. The countdown is centred inside the arc; the timer name appears below. The number of tiles per row is controlled by `columns`.

### Progress Tracking

Both modes show elapsed progress. The card derives the total duration from the View Assist API response (`duration`, `total_duration`, or the first-observed `seconds_remaining`). Progress is updated every second without re-fetching from the API.

### Scrollable Card

Set `max_height` to a pixel value (e.g. `300`) to cap the card body height. A thin scrollbar appears when the content overflows.

### Hide When Empty

Set `hide_when_empty: true` to collapse the card completely when there are no active timers, alarms, or reminders. The card reappears automatically as soon as one becomes active.

### Ringing Popup

When `show_ringing_popup: true` (the default), a floating panel appears in the bottom-right corner of the screen whenever one or more alarms are ringing. The popup:

- Lists each ringing alarm by name with colour-coded labels.
- Offers configurable snooze buttons (e.g. Snooze 5m, Snooze 10m).
- Has a **Stop** button to dismiss the alarm immediately.
- Disappears automatically once all ringing alarms have been snoozed or stopped.

The popup escapes the card's shadow DOM so it overlays the full screen, regardless of where the card sits on the dashboard.

### Draggable Popup

With `popup_movable: true`, the ringing popup can be dragged to any position on screen using mouse or touch. Button clicks inside the popup are never treated as drag actions.

### Ringing Actions (Main Card)

Ringing timers in the main card also show action buttons directly in the row/tile — snooze options and a Stop button — so you can act without relying on the popup.

---

## Timer Types

| Type | Colour |
|---|---|
| Timer | Blue `#039be5` |
| Alarm | Red `#e53935` |
| Reminder | Orange `#fb8c00` |

---

## Theming

The card uses Home Assistant CSS variables throughout (`--primary-text-color`, `--secondary-text-color`, `--primary-color`, `--divider-color`, `--secondary-background-color`, `--ha-card-background`) so it adapts automatically to light and dark themes.

---

## Planned

- Button to manually create a timer, alarm, or reminder from within the card.
