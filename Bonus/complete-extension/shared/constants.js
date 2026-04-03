/**
 * =============================================================================
 * FILE: shared/constants.js
 * PURPOSE: Single source of truth for all configuration values and message
 *          types used across the entire extension.
 * USED BY: service-worker.js (via importScripts)
 *          content-main.js   (via manifest content_scripts injection)
 *          form-detector.js  (via manifest content_scripts injection)
 *          suggestion-card.js (via manifest content_scripts injection)
 * WHY PLAIN JS: MV3 content scripts cannot use ES modules. By keeping this
 *               as plain JS attached to window.PB, ALL contexts can share
 *               the same file — no duplication needed.
 * =============================================================================
 */

// Guard: prevent re-declaration if script is injected more than once
if (typeof window !== 'undefined' && !window.PB) {
  window.PB = {};
}

// In service worker context, 'window' doesn't exist — use globalThis
var PB = (typeof window !== 'undefined' ? window : globalThis).PB || {};
(typeof window !== 'undefined' ? window : globalThis).PB = PB;

// =============================================================================
// MAIN CONFIG OBJECT
// All magic numbers live here. Change here, changes everywhere.
// =============================================================================
PB.CONFIG = {

  // ── Relevance Scoring (FR-02) ──────────────────────────────────────────────
  // Minimum score required to show a peer suggestion card.
  // 0.60 = conservative default. Erring low means fewer interruptions.
  RELEVANCE_THRESHOLD: 0.60,
  //set it to 0.3 for instant testing

  // ── AI Chat Trigger (FR-03) ────────────────────────────────────────────────
  // Number of user messages in a single AI chat session before we evaluate.
  AI_CHAT_MESSAGE_THRESHOLD: 3,

  // ── Form Page Trigger (FR-04) ──────────────────────────────────────────────
  // Both conditions must be true simultaneously to trigger on a form page.
  FORM_TIME_THRESHOLD_MS: 60000,  // 60 seconds on the page
  FORM_FIELD_THRESHOLD: 5,         // 5 or more visible form fields

  // ── Session Limits (FR-14, FR-15) ─────────────────────────────────────────
  // Max dismissals before suppressing ALL suggestions for the session.
  MAX_DISMISSALS_PER_SESSION: 3,
  // Max suggestions shown per browsing session (regardless of dismissals).
  MAX_SUGGESTIONS_PER_SESSION: 2,
  // Minimum gap between two suggestions (10 minutes).
  SUGGESTION_COOLDOWN_MS: 600000,
  //set it to 0.5 for instant testing

  // ── Card Behaviour (FR-08, FR-10) ─────────────────────────────────────────
  // Card must appear within 1 second of trigger (FR-08).
  CARD_RENDER_BUDGET_MS: 1000,
  // Auto-dismiss countdown for AI chat pages (FR-10).
  AUTO_DISMISS_MS: 30000,

  // ── Onboarding (FR-16) ────────────────────────────────────────────────────
  GOAL_CONTEXT_MAX_CHARS: 200,

  // ── Connect Handoff (FR-24) ───────────────────────────────────────────────
  PEER_CONNECTION_BASE_URL: 'https://app.peerbridge.io/connect',

  // ── Page Types ────────────────────────────────────────────────────────────
  // Used to route context signals to the correct scorer function.
  PAGE_TYPE: {
    SEARCH:  'search',
    AI_CHAT: 'ai_chat',
    FORM:    'form',
    UNKNOWN: 'unknown'
  },

  // ── Target Host Patterns (FR-01) ──────────────────────────────────────────
  // These must match the content_scripts.matches in manifest.json.
  TARGET_HOSTS: {
    GOOGLE:  'www.google.com',
    BING:    'www.bing.com',
    CHATGPT: ['chat.openai.com', 'chatgpt.com'],
    CLAUDE:  'claude.ai',
    GEMINI:  'gemini.google.com'
  },

  // ── Storage Keys ──────────────────────────────────────────────────────────
  // Centralised to prevent typos causing silent storage misses.
  STORAGE_KEYS: {
    GOAL_CONTEXT:    'pb_goal_context',     // Encrypted ciphertext
    GOAL_CONTEXT_IV: 'pb_goal_context_iv',  // AES-GCM IV vector
    OPT_IN:          'pb_opt_in',           // Boolean: user opted in
    ONBOARDING_DONE: 'pb_onboarding_done',  // Boolean: onboarding completed
    FREQUENCY:       'pb_frequency',        // 'active' | 'reduced' | 'paused'
    PAUSED_UNTIL:    'pb_paused_until',     // Timestamp: paused until end of day
    CRYPTO_KEY:      'pb_crypto_key'        // Raw AES-GCM key bytes
  },

  // ── Session Keys (chrome.storage.session) ─────────────────────────────────
  // Cleared automatically when browser closes. Never persists across restarts.
  SESSION_KEYS: {
    DISMISSAL_COUNT:    'pb_sess_dismissals',
    SUGGESTION_COUNT:   'pb_sess_suggestions',
    LAST_SUGGESTION_TS: 'pb_sess_last_ts',
    SUPPRESSED:         'pb_sess_suppressed',
    AI_MSG_COUNT:       'pb_sess_ai_msgs'
  },

  // ── Frequency Modes (FR-20) ───────────────────────────────────────────────
  FREQUENCY: {
    ACTIVE:  'active',   // Show up to MAX_SUGGESTIONS_PER_SESSION
    REDUCED: 'reduced',  // Max 1 per session
    PAUSED:  'paused'    // Show nothing
  }
};

// =============================================================================
// MESSAGE TYPES
// All chrome.runtime.sendMessage type strings defined here.
// Both sender (content scripts) and receiver (SW) use these same values.
// =============================================================================
PB.MESSAGES = {
  // Content Script → Service Worker
  SCORE_CONTEXT:      'SCORE_CONTEXT',      // Send page signals for scoring
  AI_MESSAGE_SENT:    'AI_MESSAGE_SENT',    // A new AI chat message was sent
  FORM_THRESHOLD_MET: 'FORM_THRESHOLD_MET', // Form time+field threshold passed
  DISMISS_CARD:       'DISMISS_CARD',       // User dismissed the card
  PAUSE_FOR_TODAY:    'PAUSE_FOR_TODAY',    // User clicked "Pause today"
  OPEN_TAB:           'OPEN_TAB',           // Open a new tab (CS can't do this)

  // Service Worker → Content Script
  SHOW_CARD:          'SHOW_CARD',          // SW tells CS to show card
  REMOVE_CARD:        'REMOVE_CARD'         // SW tells CS to remove card
};

console.log('[PeerBridge] constants.js loaded — PB.CONFIG and PB.MESSAGES ready.');
