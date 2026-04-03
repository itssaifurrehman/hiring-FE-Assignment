/**
 * =============================================================================
 * FILE: src/background/service-worker.js
 * PURPOSE: Central orchestrator for the extension. Handles all business logic:
 *          scoring, session state, peer API, badge management, and messaging.
 * MV3 NOTE: Classic service worker (no "type":"module" in manifest).
 *           Uses importScripts() to load shared utilities.
 *           State is NEVER held in memory — always written to storage.session
 *           immediately because MV3 SWs can be killed at any time.
 * =============================================================================
 */

// =============================================================================
// IMPORTS — load shared utilities via importScripts (MV3 classic SW pattern)
// Order matters: constants must load before storage and scorer.
// =============================================================================
importScripts(
  '../../shared/constants.js',
  '../../shared/storage.js',
  '../../shared/scorer.js'
);

console.log('[PeerBridge:SW] Service worker started — all imports loaded');

// Shorthand references after import
var CONFIG   = PB.CONFIG;
var MESSAGES = PB.MESSAGES;

// =============================================================================
// INSTALL — runs once on first install or extension update
// =============================================================================

/**
 * onInstalled listener
 * On first install: checks if onboarding is needed and opens popup as a tab.
 * Opens as a tab (not popup) because openPopup() requires a user gesture
 * which is unavailable in the install event.
 */
chrome.runtime.onInstalled.addListener(function (details) {
  console.log('[PeerBridge:SW] onInstalled fired — reason:', details.reason);

  if (details.reason === 'install') {
    PB.isOnboardingComplete().then(function (done) {
      if (!done) {
        console.log('[PeerBridge:SW] First install — opening onboarding tab');
        chrome.tabs.create({
          url: chrome.runtime.getURL('src/popup/popup.html?onboarding=true')
        });
      }
    });
  }

  // Always refresh badge on install/update
  updateBadge();
});

// =============================================================================
// MESSAGE HANDLER — routes all messages from content scripts
// =============================================================================

/**
 * onMessage listener
 * Single entry point for all content script → SW communication.
 * Returns true to keep the message channel open for async responses.
 */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  console.log('[PeerBridge:SW] Message received:', message.type, '| from tab:', sender.tab && sender.tab.id);

  handleMessage(message, sender)
    .then(function (response) {
      console.log('[PeerBridge:SW] Sending response for', message.type, ':', response);
      sendResponse(response);
    })
    .catch(function (err) {
      console.error('[PeerBridge:SW] Handler error for', message.type, ':', err);
      sendResponse({ error: err.message });
    });

  return true; // REQUIRED: keeps channel open for async sendResponse
});

/**
 * handleMessage
 * Routes incoming messages to the correct handler function.
 * @param {object} message - { type, payload }
 * @param {object} sender
 * @returns {Promise<object>}
 */
async function handleMessage(message, sender) {
  var type    = message.type;
  var payload = message.payload || {};

  switch (type) {

    // Content script sends page signals for scoring
    case MESSAGES.SCORE_CONTEXT:
      return handleScoreContext(payload, sender);

    // A new message was sent in an AI chat session
    case MESSAGES.AI_MESSAGE_SENT:
      return handleAiMessageSent(payload, sender);

    // Form detector: both time + field thresholds met
    case MESSAGES.FORM_THRESHOLD_MET:
      return handleFormThresholdMet(payload, sender);

    // User dismissed the suggestion card
    case MESSAGES.DISMISS_CARD:
      return handleDismissCard(payload);

    // User clicked "Pause for today" on the card (FR-21)
    case MESSAGES.PAUSE_FOR_TODAY:
      return handlePauseForToday();

    // Content scripts can't open tabs — they ask the SW (MV3 restriction)
    case MESSAGES.OPEN_TAB:
      return handleOpenTab(payload);

    default:
      console.warn('[PeerBridge:SW] Unknown message type:', type);
      return { error: 'Unknown message type: ' + type };
  }
}

// =============================================================================
// CONTEXT SCORING HANDLERS
// =============================================================================

/**
 * handleScoreContext
 * Main scoring pipeline. Checks all gates, runs the scorer, fetches peer match.
 * Returns { show: true, matchData, pageType, autoDissmiss } if card should show.
 * Returns { show: false, reason } if blocked at any gate.
 * @param {object} payload - context signals from content script
 * @param {object} sender
 * @returns {Promise<object>}
 */
async function handleScoreContext(payload, sender) {
  console.log('[PeerBridge:SW] handleScoreContext — pageType:', payload.pageType);

  // ── Gate 1: Session limits and pause state ─────────────────────────────────
  var canShow = await PB.canShowSuggestion();
  if (!canShow.allowed) {
    console.log('[PeerBridge:SW] Gate 1 BLOCKED:', canShow.reason);
    return { show: false, reason: canShow.reason };
  }

  // ── Gate 2: Frequency preference ──────────────────────────────────────────
  var prefs     = await PB.getPreferences();
  var frequency = prefs[CONFIG.STORAGE_KEYS.FREQUENCY] || CONFIG.FREQUENCY.ACTIVE;

  if (frequency === CONFIG.FREQUENCY.PAUSED) {
    console.log('[PeerBridge:SW] Gate 2 BLOCKED: frequency set to paused');
    return { show: false, reason: 'frequency_paused' };
  }

  if (frequency === CONFIG.FREQUENCY.REDUCED) {
    var state = await PB.getSessionState();
    if (state.suggestionCount >= 1) {
      console.log('[PeerBridge:SW] Gate 2 BLOCKED: reduced mode, already shown 1');
      return { show: false, reason: 'reduced_limit_reached' };
    }
  }

  // ── Score the context ──────────────────────────────────────────────────────
  var score = 0;

  switch (payload.pageType) {
    case CONFIG.PAGE_TYPE.SEARCH:
      score = PB.scoreSearchContext(payload);
      break;
    case CONFIG.PAGE_TYPE.AI_CHAT:
      score = PB.scoreAIChatContext(payload);
      break;
    case CONFIG.PAGE_TYPE.FORM:
      score = PB.scoreFormContext(payload);
      break;
    default:
      console.warn('[PeerBridge:SW] Unknown page type:', payload.pageType);
      return { show: false, reason: 'unknown_page_type' };
  }

  // ── Gate 3: Relevance threshold (FR-02) ───────────────────────────────────
  if (!PB.isAboveThreshold(score)) {
    console.log('[PeerBridge:SW] Gate 3 BLOCKED: score', score, '< threshold', CONFIG.RELEVANCE_THRESHOLD);
    return { show: false, reason: 'below_threshold', score: score };
  }

  // ── Fetch peer match ───────────────────────────────────────────────────────
  var anonymisedCtx = PB.buildAnonymisedContext({
    pageType:     payload.pageType,
    query:        payload.query,
    messageCount: payload.messageCount,
    fieldCount:   payload.fieldCount
  });

  var matchData = await fetchPeerMatch(anonymisedCtx);

  // NFR-05: If API is unreachable, suppress silently — no error shown to user
  if (!matchData) {
    console.log('[PeerBridge:SW] Peer match API unavailable — suppressing silently (NFR-05)');
    return { show: false, reason: 'api_unavailable' };
  }

  // ── Record this suggestion ─────────────────────────────────────────────────
  await PB.incrementSuggestionCount();

  console.log('[PeerBridge:SW] All gates passed — showing card. score:', score, '| match:', matchData.matchId);

  return {
    show:         true,
    score:        score,
    matchData:    matchData,
    pageType:     payload.pageType,
    autoDissmiss: payload.pageType === CONFIG.PAGE_TYPE.AI_CHAT // FR-10
  };
}

/**
 * handleAiMessageSent
 * Called every time the user sends a message in an AI chat.
 * Increments the AI message counter and re-runs scoring if threshold met (FR-03).
 * @param {object} payload
 * @param {object} sender
 * @returns {Promise<object>}
 */
async function handleAiMessageSent(payload, sender) {
  console.log('[PeerBridge:SW] handleAiMessageSent');

  var newCount = await PB.incrementAiMessageCount();
  console.log('[PeerBridge:SW] AI message count now:', newCount, '| threshold:', CONFIG.AI_CHAT_MESSAGE_THRESHOLD);

  if (newCount >= CONFIG.AI_CHAT_MESSAGE_THRESHOLD) {
    console.log('[PeerBridge:SW] AI message threshold met — running scorer');
    return handleScoreContext(
      Object.assign({}, payload, {
        pageType:     CONFIG.PAGE_TYPE.AI_CHAT,
        messageCount: newCount
      }),
      sender
    );
  }

  return { show: false, reason: 'ai_message_count_below_threshold', count: newCount };
}

/**
 * handleFormThresholdMet
 * Called when form-detector reports both time + field thresholds met (FR-04).
 * @param {object} payload
 * @param {object} sender
 * @returns {Promise<object>}
 */
async function handleFormThresholdMet(payload, sender) {
  console.log('[PeerBridge:SW] handleFormThresholdMet — fields:', payload.fieldCount, 'time:', payload.timeSpentMs + 'ms');
  return handleScoreContext(
    Object.assign({}, payload, { pageType: CONFIG.PAGE_TYPE.FORM }),
    sender
  );
}

// =============================================================================
// DISMISSAL HANDLER (FR-13, FR-14)
// =============================================================================

/**
 * handleDismissCard
 * Records a dismissal. If 3 dismissals reached, suppresses for the session.
 * @param {object} payload - { reason: 'manual' | 'auto' | 'connect' | 'pause' }
 * @returns {Promise<object>}
 */
async function handleDismissCard(payload) {
  console.log('[PeerBridge:SW] handleDismissCard — reason:', payload.reason);

  var result = await PB.incrementDismissalCount();

  if (result.suppressed) {
    console.log('[PeerBridge:SW] 3 dismissals reached — session suppressed (FR-14)');
    await updateBadge();
  }

  return { dismissalCount: result.dismissalCount, suppressed: result.suppressed };
}

// =============================================================================
// PAUSE HANDLER (FR-21, FR-22, FR-23)
// =============================================================================

/**
 * handlePauseForToday
 * Pauses suggestions until end of today (FR-21).
 * Updates badge immediately (FR-22).
 * Sends REMOVE_CARD to all tabs immediately (FR-23 — no page reload needed).
 * @returns {Promise<object>}
 */
async function handlePauseForToday() {
  console.log('[PeerBridge:SW] handlePauseForToday');

  await PB.pauseForToday();
  await updateBadge();

  // FR-23: effect is immediate — remove card from all open tabs
  var tabs = await chrome.tabs.query({});
  var removeMessage = { type: MESSAGES.REMOVE_CARD, payload: { reason: 'paused' } };

  tabs.forEach(function (tab) {
    chrome.tabs.sendMessage(tab.id, removeMessage).catch(function () {
      // Tab may not have content script — silently ignore
    });
  });

  console.log('[PeerBridge:SW] Paused for today — card removed from all tabs');
  return { paused: true };
}

// =============================================================================
// OPEN TAB HANDLER (FR-24)
// Content scripts cannot call chrome.tabs.create — they send OPEN_TAB to SW.
// =============================================================================

/**
 * handleOpenTab
 * Opens a new tab to the peer connection URL with match_id and context_token.
 * @param {object} payload - { url: string }
 * @returns {Promise<object>}
 */
async function handleOpenTab(payload) {
  console.log('[PeerBridge:SW] handleOpenTab — url:', payload.url);
  await chrome.tabs.create({ url: payload.url });
  return { opened: true };
}

// =============================================================================
// BADGE MANAGEMENT (FR-22)
// =============================================================================

/**
 * updateBadge
 * Updates the toolbar icon badge to reflect paused/active state.
 * Shows '||' badge with grey background when paused (FR-22).
 * Clears badge when active.
 */
async function updateBadge() {
  console.log('[PeerBridge:SW] updateBadge — checking state');

  var paused = await PB.isPausedForToday();
  var prefs  = await PB.getPreferences();
  var freq   = prefs[CONFIG.STORAGE_KEYS.FREQUENCY] || CONFIG.FREQUENCY.ACTIVE;

  var isPaused = paused || freq === CONFIG.FREQUENCY.PAUSED;

  if (isPaused) {
    await chrome.action.setBadgeText({ text: '||' });
    await chrome.action.setBadgeBackgroundColor({ color: '#9CA3AF' });
    console.log('[PeerBridge:SW] Badge set to PAUSED');
  } else {
    await chrome.action.setBadgeText({ text: '' });
    console.log('[PeerBridge:SW] Badge cleared — ACTIVE');
  }
}

// =============================================================================
// STORAGE CHANGE LISTENER (FR-23)
// Preferences take effect immediately without page reload.
// =============================================================================

/**
 * onChanged listener
 * Watches for frequency or pause preference changes and updates badge
 * immediately — no page reload required (FR-23).
 */
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;

  var badgeKeys = [CONFIG.STORAGE_KEYS.FREQUENCY, CONFIG.STORAGE_KEYS.PAUSED_UNTIL];
  var needsBadgeUpdate = badgeKeys.some(function (k) { return k in changes; });

  if (needsBadgeUpdate) {
    console.log('[PeerBridge:SW] Storage changed — updating badge');
    updateBadge();
  }
});

// =============================================================================
// PEER MATCH API (FR-24, FR-25, NFR-05)
// =============================================================================

/** Mock peer data for the assignment prototype */
var MOCK_PEERS = [
  {
    matchId:          'peer_001',
    domain:           'Career Transitions',
    yearsExperience:  8,
    availability:     'Available now',
    availabilitySignal: 'online',
    suggestionPrompt: 'Someone who navigated this exact crossroads is available.'
  },
  {
    matchId:          'peer_002',
    domain:           'Financial Planning',
    yearsExperience:  12,
    availability:     'Responds within 2 hrs',
    availabilitySignal: 'soon',
    suggestionPrompt: 'A peer with hands-on experience here wants to help.'
  },
  {
    matchId:          'peer_003',
    domain:           'Immigration & Visas',
    yearsExperience:  5,
    availability:     'Available today',
    availabilitySignal: 'today',
    suggestionPrompt: 'Real experience beats another search result.'
  }
];

/**
 * fetchPeerMatch
 * Fetches a peer match for the given anonymised context.
 * In production: POST to peer match API.
 * In this prototype: returns mock data after simulated network delay.
 * NFR-05: Returns null on any failure — never throws, never shows error UI.
 * @param {object} anonymisedContext
 * @returns {Promise<object|null>}
 */
async function fetchPeerMatch(anonymisedContext) {
  console.log('[PeerBridge:SW] fetchPeerMatch — context:', anonymisedContext);

  try {
    // Simulate network latency
    await new Promise(function (resolve) { setTimeout(resolve, 150); });

    var peer = MOCK_PEERS[Math.floor(Math.random() * MOCK_PEERS.length)];
    var result = Object.assign({}, peer, {
      contextToken: generateContextToken(anonymisedContext)
    });

    console.log('[PeerBridge:SW] fetchPeerMatch — matched:', result.matchId, result.domain);
    return result;

  } catch (err) {
    // NFR-05: Fail silently — no error UI shown to user
    console.warn('[PeerBridge:SW] fetchPeerMatch failed silently (NFR-05):', err);
    return null;
  }
}

/**
 * generateContextToken
 * Creates an opaque short-lived token for the connect handoff URL (FR-24).
 * Token contains only non-PII context: page type and timestamp.
 * In production: this would be a server-issued signed token.
 * @param {object} context
 * @returns {string}
 */
function generateContextToken(context) {
  var safe = {
    pt: context.pageType,
    ts: context.timestamp
  };
  // btoa encodes to base64. Removing = padding for URL cleanliness.
  return btoa(JSON.stringify(safe)).replace(/=/g, '');
}

console.log('[PeerBridge:SW] service-worker.js fully initialised and ready.');
