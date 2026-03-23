# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SavePoint** is a single-file, zero-dependency version/checkpoint management UI. The entire application — HTML, CSS, and JavaScript — lives in `savepoint.html`. No build step, no package manager, no framework.

To run: open `savepoint.html` directly in a browser.

## Architecture

The app is a client-side SPA with localStorage persistence. Layout is a fixed two-panel design:

- **Sidebar**: project selector, save list grouped by date (Today / Yesterday / Earlier), storage info
- **Main panel**: savepoint details (metadata, file diffs, timeline visualization) or Settings view
- **Overlay**: modal for creating new savepoints, toast notifications

**State management**: all saves are stored in `localStorage` under `savepoint_saves` (JSON array) and `savepoint_selected` (current save ID). No server, no external state.

**Save object shape**:
```js
{
  id: string,           // e.g. "s1" or "s" + Date.now()
  name: string,
  desc: string,
  type: 'auto' | 'manual',
  time: number,         // Unix timestamp (ms)
  delta: string,        // e.g. "+2.3 KB" or "全量"
  diffIdx: number,      // index into fakeDiffs[] for mock file changes
  cloud: boolean
}
```

**Key functions** (all in the single `<script>` block):

| Function | Role |
|---|---|
| `loadSaves()` / `saveSaves()` | localStorage read/write |
| `getDefaultSaves()` | Seeds demo data on first load |
| `renderSidebar()` | Re-renders save list with date grouping |
| `renderMain()` | Renders savepoint detail or Settings panel |
| `renderTimeline()` | Horizontal timeline visualization |
| `createSave()` | Adds new savepoint and persists |
| `deleteSave()` | Removes with confirmation |
| `rollback()` | UI-only rollback simulation |
| `showNotif()` | Toast notification |
| `formatTime()` | Relative time strings in Chinese |

## Design System

CSS custom properties are defined at `:root` (top of `<style>`):

- Dark theme background: `#0e0f11`
- Accent purple: `#7c6af7`
- Status colors: green `#3ecf8e`, amber `#f59e0b`, red `#f87171`, blue `#60a5fa`
- Fonts: JetBrains Mono (monospace), Syne (sans-serif) — loaded from Google Fonts

## What Is and Isn't Implemented

**Implemented (UI only)**:
- Create, view, delete savepoints
- Rollback (shows notification, no actual file ops)
- Timeline visualization
- Settings panel (auto-save interval, retention, format)
- Storage usage bar
- Keyboard shortcuts: `Ctrl/Cmd+S` to open save modal, `Esc` to close

**Not implemented (stubs/CTAs)**:
- Cloud sync (Pro feature CTA only)
- Project switching ("coming soon" notification)
- Actual file monitoring, diff calculation, or file I/O
- Tauri desktop integration (referenced in settings UI but not wired up)

The `fakeDiffs` array (5 entries) provides mock file change data for the detail panel.
