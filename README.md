# hiring-FE-Assignment
Sapience.ai hiring assignment - Saif

# HIRING ASSIGNMENT README

### Part A  Figma Mockups (open in browser: link/pdf)
1. Open foler → `1. Figma Mockups`
2. Open `Figma Mockups.pdf` to view all the pages in 1 pdf
OR
5. Navigate to `https://www.figma.com/design/q0N3kymuY3cqtsAURBLeBT/HIRING-ASSIGNMENT---SAIF?node-id=0-1&t=6KeL4bJKcMqWtqwS-1` to open directly on figma.

### Part B  Card Prototype (open in browser, no build step)
1. Open foler → `2. HTML Standalone File`

```bash
open card-prototype.html
# or just double-click it in Finder / Explorer
```

- Use the **demo buttons** (top-left) to trigger Search, AI Chat, and Form card variants
- AI Chat card auto-dismisses after **30 seconds** with a countdown progress bar
- Toggle your OS dark mode to see the dark mode variant
- All interactions (Connect, Not now, Pause today, Escape key) are functional

### Part C — Written Rational (open in browser, no build step)
1. Open foler → `3. Written Rational`
2. Open `Written Rationale - Saif.pdf` to read through all the answers based on my assumption


### Load as Chrome Extension (full architecture)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder (`Bonus/complete-extension/`)

**Test it:**
- Go to `https://www.google.com/search?q=should+I+change+career+at+32`
- Card appears within ~1 second (scoring threshold met)
- Go to `https://chat.openai.com` → send 3+ messages → card appears after threshold

---

## Project Structure
```
complete-extension/
├── manifest.json                  ← MV3 manifest, permissions, contexts, icons
├── assets/
│   └── icons/                     ← Extension toolbar icons (16, 32, 48, 128px)
├── shared/                        ← Shared plain JS, loaded by SW + content scripts
│   ├── constants.js               ← Single source of truth (window.PB namespace)
│   ├── storage.js                 ← Web Crypto encryption + chrome.storage helpers
│   └── scorer.js                  ← Relevance scoring engine (pure functions)
├── src/
│   ├── background/
│   │   └── service-worker.js      ← Central orchestrator (classic SW, importScripts)
│   ├── components/
│   │   └── suggestion-card.js     ← Shadow DOM card (plain JS IIFE)
│   ├── content/
│   │   ├── content-main.js        ← Target page detection + AI chat observer
│   │   └── form-detector.js       ← Form-heavy page detection
│   └── popup/
│       ├── popup.html             ← Popup HTML structure (no inline JS/CSS)
│       ├── popup.css              ← All popup styles
│       └── popup.js               ← All popup logic
├── card-prototype.html            ← Part B standalone deliverable
├── FUNCTIONS.md                   ← Complete function reference manual
```


---

## Architecture

### Why No ES Modules in Content Scripts?

MV3 content scripts run as plain scripts injected into web pages. They cannot use
`import/export`. Only the background service worker supports `"type":"module"`.

**Our solution:** All shared code uses plain JS attached to the `window.PB` namespace.
The service worker loads shared files via `importScripts()` (classic SW only, removing
`"type":"module"` from manifest unlocks this). One set of files works everywhere.

### Why `chrome.storage.session` for Session State?

MV3 service workers are ephemeral, Chrome kills them after ~30 seconds of inactivity.
Any in-memory state is lost. `chrome.storage.session` is cleared on browser restart
(perfect for session-scoped counters) but persists across SW restarts within a session.
Every state change is written immediately — never buffered in memory.

### Why Shadow DOM Closed Mode?

The card is injected into pages we don't control, Google, ChatGPT, SaaS forms.
Closed Shadow DOM means:
- Host page CSS cannot break our card styles
- Host page JS cannot reach our DOM
- Our styles cannot leak into the host page

This is the only correct approach for a production-grade injected UI.

### Why Conservative Scoring (0.60 threshold)?

False positives (card appears when not needed) are worse than false negatives.
A card appearing during casual browsing feels like an ad, users uninstall immediately.
We err conservative. Users who want more suggestions can set frequency to Active.

### Message Flow

```
Content Script → SW: context signals (anonymised, no PII)
SW → Content Script: show/no-show decision + match data
SW → All Tabs: DISMISS_CARD broadcast on pause (FR-23)
Popup → SW: preference changes, pause state
```

---

## Requirements Coverage

All 25 Functional Requirements, 5 NFRs, and 6 User Stories are implemented.
See `FUNCTIONS.md` for the complete FR → implementation map.

---

## What I'd Build Next

1. **Real relevance scoring** replace keyword heuristics with a lightweight ONNX model
   client-side. More signal, same privacy guarantees.

2. **Peer availability websocket** real-time availability instead of static mock data.

3. **E2E tests** Playwright tests simulating search queries and AI chat sessions,
   asserting card appears and dismisses correctly.

4. **Smarter timing** hold the trigger if user typed in the last 8 seconds.
   Wait for a natural pause before showing the card.
