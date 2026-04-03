# complete-extension — Function Manual

Complete reference for every function in the extension. Explains what each function does, why it exists, which files use it, and which FR/NFR it satisfies.

---

## shared/constants.js

This file is the single source of truth for all configuration values and message type strings. It is injected before every other script via manifest ordering.

**`window.PB.CONFIG`** — Configuration object. Every magic number (thresholds, timeouts, limits) lives here. No other file hardcodes these values. Changing a value here changes it everywhere. Used by service-worker.js, content-main.js, form-detector.js, suggestion-card.js, popup.js.

**`window.PB.MESSAGES`** — Message type strings. Both sides of every `chrome.runtime.sendMessage` call reference these constants. Prevents typos from creating silent communication failures. FR reference: all FR involving inter-context communication.

---

## shared/storage.js

All chrome.storage operations and Web Crypto encryption. Only used by the service worker via importScripts.

**`PB.getOrCreateCryptoKey()`** — Retrieves the stored AES-GCM key from chrome.storage.local, or generates a new 256-bit key on first run and stores it. Returns a CryptoKey object ready for encrypt/decrypt. FR-19.

**`PB.encryptValue(plaintext)`** — Encrypts a string using AES-GCM with a random 12-byte IV. Returns `{ciphertext: number[], iv: number[]}`. Called by saveGoalContext. FR-19.

**`PB.decryptValue({ciphertext, iv})`** — Decrypts a previously encrypted value. Returns the original plaintext string. Throws if key or data is corrupt. FR-19.

**`PB.saveGoalContext(plaintext)`** — Top-level function to encrypt and persist the user's goal context. If plaintext is empty, removes the stored context entirely. FR-19, US-06.

**`PB.loadGoalContext()`** — Decrypts and returns the stored goal context. Returns null if not set or if decryption fails silently. Used by the scoring pipeline to personalise peer matching.

**`PB.getPreferences()`** — Single read of all user preferences (opt-in, onboarding, frequency, paused-until) from chrome.storage.local. Returns a plain object. Used by the SW before every scoring decision.

**`PB.setPreference(key, value)`** — Generic preference setter. Wraps chrome.storage.local.set for a single key.

**`PB.isOnboardingComplete()`** — Returns true if the user has completed or skipped onboarding. Used by the SW onInstalled handler to decide whether to open the onboarding tab. FR-16.

**`PB.isPausedForToday()`** — Returns true if PAUSED_UNTIL is set and is in the future. Used in canShowSuggestion as one of the session gates. FR-21.

**`PB.pauseForToday()`** — Sets PAUSED_UNTIL to 23:59:59 of the current day. Called by handlePauseForToday in the SW. FR-21.

**`PB.getSessionState()`** — Reads all session counters (dismissals, suggestions, last timestamp, suppressed flag, AI message count) from chrome.storage.session in a single call. MV3 SWs can be killed at any time so state is never held in memory. FR-14, FR-15.

**`PB.incrementDismissalCount()`** — Increments the dismissal counter. If the count reaches MAX_DISMISSALS_PER_SESSION (3), sets the suppressed flag to true. Returns the new count and suppressed state. FR-14.

**`PB.incrementSuggestionCount()`** — Records that a suggestion was shown by incrementing the suggestion counter and saving the current timestamp. The timestamp is used for cooldown enforcement. FR-15.

**`PB.incrementAiMessageCount()`** — Increments the AI message counter in session storage. Returns the new count. Used to detect when the FR-03 threshold of 3 messages is met. FR-03.

**`PB.canShowSuggestion()`** — Master gate function called before every potential card display. Checks five conditions in sequence: paused for today, session suppressed, session limit reached, cooldown active, frequency mode. Returns `{allowed: boolean, reason: string}`. FR-14, FR-15, FR-21.

---

## shared/scorer.js

Pure scoring functions. No side effects, no storage access. All functions take plain data objects and return scores.

**`PB.GOAL_KEYWORDS`** — Array of keyword phrases indicating goal-oriented user intent. Used by all three scorer functions to add weight to matching queries. Examples: "should i", "career change", "how do i decide".

**`PB.FRUSTRATION_KEYWORDS`** — Array of phrases indicating AI frustration. Carry double weight in scoreAIChatContext because they are the clearest signal that AI has peaked. Examples: "that's not what i asked", "you keep saying".

**`PB.scoreSearchContext({query})`** — Scores a search query 0.0–1.0. Signals used: query length, goal keyword hits, question structure (starts with how/should/what), word count. Short casual queries score near zero. Long goal-oriented queries score above threshold. FR-01, FR-02.

**`PB.scoreAIChatContext({messageCount, recentMessages, sessionDurationMs})`** — Scores an AI chat session 0.0–1.0. Signals: message count (primary), session duration, goal keywords in recent messages, frustration keywords (double weight). FR-01, FR-02, FR-03.

**`PB.scoreFormContext({fieldCount, timeSpentMs, pageTitle, pageUrl})`** — Scores a form-heavy page 0.0–1.0. Has a hard gate: both fieldCount >= 5 AND timeSpentMs >= 60000 must be true or returns 0 immediately. Additional weight for more fields, longer time, and high-stakes URL context (immigration, mortgage, etc). FR-01, FR-02, FR-04.

**`PB.isAboveThreshold(score, threshold)`** — Returns true if score >= threshold. Threshold defaults to CONFIG.RELEVANCE_THRESHOLD (0.60). Separated from the scorer functions so the threshold can be overridden for testing. FR-02.

**`PB.buildAnonymisedContext({pageType, query, messageCount, fieldCount})`** — Creates a PII-free context object for the peer match API. Strips emails, long numbers, and proper nouns from queries. Caps length at 120 characters. This is the only data sent externally. FR-05.

---

## src/background/service-worker.js

The central orchestrator. All business logic runs here.

**`chrome.runtime.onInstalled` listener** — Fires on first install. Checks if onboarding is complete. If not, opens the popup as a new tab (openPopup() requires a user gesture so is not usable here). Also refreshes the badge state. FR-16.

**`chrome.runtime.onMessage` listener** — Single entry point for all content script → SW messages. Routes to the correct handler by message type. Returns true to keep the async channel open. Required pattern for async sendResponse in MV3.

**`handleMessage(message, sender)`** — Routes messages to handler functions via switch statement. Handles: SCORE_CONTEXT, AI_MESSAGE_SENT, FORM_THRESHOLD_MET, DISMISS_CARD, PAUSE_FOR_TODAY, OPEN_TAB.

**`handleScoreContext(payload, sender)`** — Main scoring pipeline. Checks canShowSuggestion, checks frequency preference, runs the correct scorer, checks isAboveThreshold, fetches peer match, increments suggestion count. Returns full show:true response or show:false with reason. FR-02, FR-24.

**`handleAiMessageSent(payload, sender)`** — Increments AI message count and re-runs scoring if threshold met. This is what enforces FR-03 progressively rather than requiring all 3 messages to arrive simultaneously. FR-03.

**`handleFormThresholdMet(payload, sender)`** — Delegates to handleScoreContext with FORM page type. Separate entry point because form detection runs on all pages via a different content script. FR-04.

**`handleDismissCard(payload)`** — Increments dismissal count. If suppressed, updates badge. Returns new count and suppressed state to content script. FR-13, FR-14.

**`handlePauseForToday()`** — Calls pauseForToday in storage, updates badge, sends REMOVE_CARD to all open tabs immediately. FR-21, FR-22, FR-23.

**`handleOpenTab(payload)`** — Opens a new tab to the provided URL. Content scripts cannot call chrome.tabs.create directly in MV3 — they send OPEN_TAB to the SW which does it. FR-24.

**`updateBadge()`** — Reads pause state and frequency preference, then sets badge text to '||' with grey background when paused, or clears it when active. FR-22.

**`chrome.storage.onChanged` listener** — Watches for frequency and pause preference changes and calls updateBadge immediately. This is what makes FR-23 (immediate effect without page reload) work.

**`fetchPeerMatch(anonymisedContext)`** — Calls the peer match API (mocked with MOCK_PEERS in this prototype). Returns null on any failure — never throws. This null return causes the SW to suppress the suggestion silently. NFR-05.

**`generateContextToken(context)`** — Creates an opaque base64 token from non-PII context (page type and timestamp). In production this would be a server-issued signed token. FR-24.

---

## src/components/suggestion-card.js

The visual card component. Self-contained Shadow DOM. Used by content-main.js and card-prototype.html.

**`SuggestionCard(opts)`** — Constructor. Accepts matchData, pageType, autoDissmiss flag, and callback functions (onConnect, onDismiss, onPauseForToday).

**`SuggestionCard.prototype.mount()`** — Creates the host div, attaches closed Shadow DOM, injects styles, builds HTML, binds events, appends to document.body. Moves focus to card for accessibility. Starts countdown if autoDissmiss. FR-06, FR-08, FR-09, FR-12.

**`SuggestionCard.prototype._buildCard()`** — Constructs the card DOM. Sets suggestion text based on page type (AI chat uses the verbatim copy from US-03). Builds peer avatar initials. Includes three action buttons: Connect, Not now, Pause today. FR-07, FR-10, FR-21.

**`SuggestionCard.prototype._bindEvents()`** — Attaches delegated click handler and keydown handler to the shadow root. Uses data-action attributes for delegation — one listener handles all three buttons. FR-12, FR-13.

**`SuggestionCard.prototype._handleTabTrap(e)`** — Implements WCAG focus trap pattern. Tab from last focusable element returns to first. Shift+Tab from first goes to last. Required for role=dialog accessibility. FR-12.

**`SuggestionCard.prototype._handleConnect()`** — Logs match_id and context_token to console. Calls onConnect callback. Dismisses card with reason 'connect'. FR-24.

**`SuggestionCard.prototype._handleDismiss()`** — Calls _dismiss with reason 'manual'. FR-13.

**`SuggestionCard.prototype._handlePause()`** — Calls onPauseForToday callback. Calls _dismiss with reason 'pause'. FR-21.

**`SuggestionCard.prototype._dismiss(reason)`** — Core dismiss logic. Guards against double-dismiss. Cancels countdown RAF. Plays slide-out animation. On animationend, removes host from DOM and calls onDismiss callback. FR-13.

**`SuggestionCard.prototype.removeImmediately()`** — Removes card without animation. Called when SW sends REMOVE_CARD (e.g. after pause from another context). FR-23.

**`SuggestionCard.prototype._startCountdown()`** — Uses requestAnimationFrame to animate a shrinking progress bar over 30 seconds. Announces "dismissing in X seconds" via aria-live at 10s and 5s for screen readers. On completion, calls _dismiss('auto'). FR-10, FR-12.

---

## src/content/content-main.js

Runs on search and AI chat pages. Detects page type, extracts signals, communicates with SW.

**`detectPageType()`** — Reads location.hostname and pathname to identify the current page type. Returns a PAGE_TYPE constant. FR-01.

**`extractSearchContext()`** — Reads query string from URL parameters (q, query, search). Strips emails and long numbers. Returns anonymised query. FR-05.

**`extractAIChatContext()`** — Reads message elements from the DOM using platform-specific selectors. Counts user messages and extracts last 3 as anonymised text. Never reads AI responses. FR-05.

**`sendToBackground(type, payload, callback)`** — Wrapper around chrome.runtime.sendMessage. Handles lastError silently. Logs all sends and responses to console.

**`maybeShowCard(response)`** — Receives SW response. If show:true, instantiates SuggestionCard with the full matchData and callback functions. Sets up onConnect to send OPEN_TAB to SW. FR-06, FR-08.

**`handleSearchPage()`** — Waits 300ms for results to render, then extracts search context and sends SCORE_CONTEXT to SW. FR-01, FR-02.

**`observeAIChatMessages()`** — Creates MutationObserver watching document.body for new message elements. Debounced 500ms. On new messages, extracts context and sends AI_MESSAGE_SENT to SW. FR-03.

**`chrome.runtime.onMessage` listener** — Listens for REMOVE_CARD from SW. Calls removeImmediately on the active card or removes by DOM ID. FR-23.

---

## src/content/form-detector.js

Runs on all pages. Detects form-heavy pages. Never reads form values.

**`getSafePageContext()`** — Returns page title and sanitised URL path. Strips UUID and numeric ID segments from the path. Used for context scoring without PII exposure. FR-05.

**`countFormFields()`** — Counts visible, interactive form fields using a CSS selector that explicitly excludes hidden, submit, button, reset, and disabled elements. Uses getComputedStyle to filter out visually hidden fields. Never accesses .value on any element. FR-04, FR-05.

**`checkAndMaybeTrigger()`** — Checks field count against threshold. If met, starts a setTimeout for 60 seconds. When timer fires, re-checks field count and sends FORM_THRESHOLD_MET to SW. Also handles card injection for non-target pages (forms on pages not in the main content_scripts entry). FR-04.

**`formObserver`** — MutationObserver watching document.body for new elements. Re-runs checkAndMaybeTrigger when DOM changes. Catches dynamically added form fields in SPA multi-step forms. Debounced 1s.

**`requestIdleCallback(init)`** — Init is deferred to browser idle time. Ensures form detection adds zero overhead to page load time. NFR-01.

---

## src/popup/popup.js

All logic for the popup UI. Handles onboarding and settings.

**`showView(viewId)`** — Toggles between onboarding and settings views by adding/removing the 'hidden' class.

**`initView()`** — On popup open, reads onboarding completion from storage and shows the correct view. Checks URL param ?onboarding=true for forced onboarding on first install. FR-16.

**`goToStep(step)`** — Navigates between onboarding steps 1–3. Updates progress dot states. Moves focus to step heading for accessibility. FR-16.

**`completeOnboarding()`** — Marks ONBOARDING_DONE and OPT_IN as true in storage. Switches to settings view. FR-16, FR-18.

**Step button listeners** — step1-next, step1-skip, step2-next, step2-skip, step3-done. Each wired to goToStep or completeOnboarding. Skip buttons go directly to completeOnboarding to satisfy FR-18. FR-16, FR-18.

**`loadSettings()`** — Reads frequency, pause state, and goal context from storage on settings view open. Calls setFrequencyUI, updatePauseToggleUI, and decryptGoalContext. FR-20.

**`updateGoalDisplay(value)`** — Updates the display element with current goal context. Applies empty state styling when null. US-06.

**`updatePauseToggleUI(paused)`** — Sets aria-checked and aria-label on the toggle button to reflect current state. FR-22.

**`pause-toggle click listener`** — Toggles pause state. When pausing: saves end-of-day timestamp, sends PAUSE_FOR_TODAY to SW. When resuming: removes PAUSED_UNTIL, sends UPDATE_BADGE to SW. FR-21, FR-22, FR-23.

**`setFrequencyUI(freq)`** — Updates the segmented control visual state. Updates freq-hint text. FR-20.

**`freq-btn click listeners`** — Save frequency to storage immediately on click. Notify SW to update badge. FR-20, FR-23.

**`openGoalEdit()`** — Loads current decrypted value into the edit textarea. Hides display, shows edit area. US-06.

**`goal-save click listener`** — Calls saveGoalContextRaw with new value, or clearGoalContext if empty. Updates display. Closes edit area. Shows confirmation toast. US-06.

**`showConfirmToast()`** — Shows "Your goal context has been updated." toast for 3 seconds. FR-20, US-06.

**`getOrCreatePopupCryptoKey(callback)`** — Popup's local version of the crypto key retrieval. Identical logic to storage.js but using callback pattern instead of async/await to avoid Promise polyfill requirements. FR-19.

**`saveGoalContextRaw(plaintext, onDone)`** — Encrypts and saves goal context using Web Crypto API. Popup cannot importScripts, so crypto logic is duplicated here. Same algorithm as storage.js: AES-GCM, 256-bit key, random IV per write. FR-19.

**`clearGoalContext(onDone)`** — Removes GOAL_CONTEXT and GOAL_CONTEXT_IV from storage. Resets suggestions to generic matching. US-06.

**`decryptGoalContext(ciphertext, iv, rawKey, callback)`** — Imports the stored raw key, decrypts the ciphertext, returns plaintext via callback. Called on settings load to display current goal context. FR-19.
