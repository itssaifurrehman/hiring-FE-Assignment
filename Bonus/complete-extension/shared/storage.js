/**
 * =============================================================================
 * FILE: shared/storage.js
 * PURPOSE: All chrome.storage read/write operations in one place.
 *          Handles AES-GCM encryption for goal context (FR-19),
 *          session state tracking (FR-14, FR-15), and user preferences.
 * USED BY: service-worker.js via importScripts()
 * WHY NOT IN CONTENT SCRIPTS: Content scripts don't need to read storage
 *          directly — they ask the SW via messages. Keeps PII handling
 *          centralised and auditable.
 * DEPENDS ON: shared/constants.js (must be loaded first via importScripts)
 * =============================================================================
 */

var PB = (typeof window !== 'undefined' ? window : globalThis).PB;

// =============================================================================
// WEB CRYPTO — AES-GCM encryption for goal context (FR-19)
// WHY: chrome.storage.local is isolated by extension origin, but encrypting
//      goal context means even if the storage file is extracted from disk,
//      the content is unreadable without the key.
// =============================================================================

/**
 * getOrCreateCryptoKey
 * Retrieves the stored AES-GCM key or generates a new one on first run.
 * Key is stored as raw bytes in chrome.storage.local alongside the data.
 * @returns {Promise<CryptoKey>}
 */
PB.getOrCreateCryptoKey = async function () {
  console.log('[PeerBridge:storage] getOrCreateCryptoKey called');

  const stored = await chrome.storage.local.get(PB.CONFIG.STORAGE_KEYS.CRYPTO_KEY);
  const rawKeyData = stored[PB.CONFIG.STORAGE_KEYS.CRYPTO_KEY];

  if (rawKeyData) {
    console.log('[PeerBridge:storage] Existing crypto key found — importing');
    return crypto.subtle.importKey(
      'raw',
      new Uint8Array(rawKeyData),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  console.log('[PeerBridge:storage] No crypto key found — generating new one');
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const rawKey = await crypto.subtle.exportKey('raw', key);
  await chrome.storage.local.set({
    [PB.CONFIG.STORAGE_KEYS.CRYPTO_KEY]: Array.from(new Uint8Array(rawKey))
  });

  console.log('[PeerBridge:storage] New crypto key generated and stored');
  return key;
};

/**
 * encryptValue
 * Encrypts a plaintext string using AES-GCM.
 * @param {string} plaintext
 * @returns {Promise<{ciphertext: number[], iv: number[]}>}
 */
PB.encryptValue = async function (plaintext) {
  console.log('[PeerBridge:storage] encryptValue — encrypting goal context');
  const key     = await PB.getOrCreateCryptoKey();
  const iv      = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  return {
    ciphertext: Array.from(new Uint8Array(cipher)),
    iv:         Array.from(iv)
  };
};

/**
 * decryptValue
 * Decrypts a previously encrypted value.
 * @param {{ciphertext: number[], iv: number[]}} payload
 * @returns {Promise<string>}
 */
PB.decryptValue = async function (payload) {
  console.log('[PeerBridge:storage] decryptValue — decrypting goal context');
  const key       = await PB.getOrCreateCryptoKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
    key,
    new Uint8Array(payload.ciphertext)
  );
  return new TextDecoder().decode(decrypted);
};

// =============================================================================
// GOAL CONTEXT — encrypted read/write
// =============================================================================

/**
 * saveGoalContext
 * Encrypts and saves the user's goal context to chrome.storage.local.
 * If value is empty, removes the stored context entirely.
 * @param {string} plaintext — the user's goal text
 */
PB.saveGoalContext = async function (plaintext) {
  console.log('[PeerBridge:storage] saveGoalContext called');

  if (!plaintext || !plaintext.trim()) {
    console.log('[PeerBridge:storage] Empty goal context — removing stored value');
    await chrome.storage.local.remove([
      PB.CONFIG.STORAGE_KEYS.GOAL_CONTEXT,
      PB.CONFIG.STORAGE_KEYS.GOAL_CONTEXT_IV
    ]);
    return;
  }

  const { ciphertext, iv } = await PB.encryptValue(plaintext.trim());
  await chrome.storage.local.set({
    [PB.CONFIG.STORAGE_KEYS.GOAL_CONTEXT]:    ciphertext,
    [PB.CONFIG.STORAGE_KEYS.GOAL_CONTEXT_IV]: iv
  });
  console.log('[PeerBridge:storage] Goal context saved (encrypted)');
};

/**
 * loadGoalContext
 * Decrypts and returns the stored goal context.
 * Returns null if not set or decryption fails.
 * @returns {Promise<string|null>}
 */
PB.loadGoalContext = async function () {
  console.log('[PeerBridge:storage] loadGoalContext called');

  const stored = await chrome.storage.local.get([
    PB.CONFIG.STORAGE_KEYS.GOAL_CONTEXT,
    PB.CONFIG.STORAGE_KEYS.GOAL_CONTEXT_IV
  ]);

  const ciphertext = stored[PB.CONFIG.STORAGE_KEYS.GOAL_CONTEXT];
  const iv         = stored[PB.CONFIG.STORAGE_KEYS.GOAL_CONTEXT_IV];

  if (!ciphertext || !iv) {
    console.log('[PeerBridge:storage] No goal context stored');
    return null;
  }

  try {
    const value = await PB.decryptValue({ ciphertext, iv });
    console.log('[PeerBridge:storage] Goal context loaded and decrypted');
    return value;
  } catch (err) {
    console.warn('[PeerBridge:storage] Goal context decryption failed — returning null', err);
    return null;
  }
};

// =============================================================================
// USER PREFERENCES
// =============================================================================

/**
 * getPreferences
 * Returns all user preferences in a single storage read.
 * @returns {Promise<object>}
 */
PB.getPreferences = async function () {
  console.log('[PeerBridge:storage] getPreferences called');
  const prefs = await chrome.storage.local.get([
    PB.CONFIG.STORAGE_KEYS.OPT_IN,
    PB.CONFIG.STORAGE_KEYS.ONBOARDING_DONE,
    PB.CONFIG.STORAGE_KEYS.FREQUENCY,
    PB.CONFIG.STORAGE_KEYS.PAUSED_UNTIL
  ]);
  console.log('[PeerBridge:storage] Preferences loaded:', prefs);
  return prefs;
};

/**
 * setPreference
 * Saves a single preference key/value.
 * @param {string} key
 * @param {*} value
 */
PB.setPreference = async function (key, value) {
  console.log('[PeerBridge:storage] setPreference:', key, '=', value);
  await chrome.storage.local.set({ [key]: value });
};

/**
 * isOnboardingComplete
 * Returns true if the user has completed or skipped onboarding.
 * @returns {Promise<boolean>}
 */
PB.isOnboardingComplete = async function () {
  const result = await chrome.storage.local.get(PB.CONFIG.STORAGE_KEYS.ONBOARDING_DONE);
  const done   = !!result[PB.CONFIG.STORAGE_KEYS.ONBOARDING_DONE];
  console.log('[PeerBridge:storage] isOnboardingComplete:', done);
  return done;
};

/**
 * isPausedForToday
 * Returns true if the user paused suggestions and the pause is still active.
 * @returns {Promise<boolean>}
 */
PB.isPausedForToday = async function () {
  const result     = await chrome.storage.local.get(PB.CONFIG.STORAGE_KEYS.PAUSED_UNTIL);
  const pausedUntil = result[PB.CONFIG.STORAGE_KEYS.PAUSED_UNTIL];
  const paused     = pausedUntil ? Date.now() < pausedUntil : false;
  console.log('[PeerBridge:storage] isPausedForToday:', paused, '(until:', new Date(pausedUntil), ')');
  return paused;
};

/**
 * pauseForToday
 * Sets the paused state until end of today (FR-21).
 */
PB.pauseForToday = async function () {
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  await chrome.storage.local.set({
    [PB.CONFIG.STORAGE_KEYS.PAUSED_UNTIL]: endOfDay.getTime()
  });
  console.log('[PeerBridge:storage] pauseForToday — paused until:', endOfDay.toISOString());
};

// =============================================================================
// SESSION STATE — uses chrome.storage.session
// WHY chrome.storage.session: MV3 service workers are ephemeral and can be
// killed at any time. In-memory state is lost when SW sleeps. session storage
// persists across SW restarts but is cleared when the browser closes —
// exactly the "browsing session" scope we need for FR-14 and FR-15.
// =============================================================================

/**
 * getSessionState
 * Returns all session-scoped counters and flags.
 * @returns {Promise<{dismissalCount, suggestionCount, lastSuggestionTs, suppressed, aiMessageCount}>}
 */
PB.getSessionState = async function () {
  const keys   = Object.values(PB.CONFIG.SESSION_KEYS);
  const result = await chrome.storage.session.get(keys);

  const state = {
    dismissalCount:   result[PB.CONFIG.SESSION_KEYS.DISMISSAL_COUNT]    || 0,
    suggestionCount:  result[PB.CONFIG.SESSION_KEYS.SUGGESTION_COUNT]   || 0,
    lastSuggestionTs: result[PB.CONFIG.SESSION_KEYS.LAST_SUGGESTION_TS] || 0,
    suppressed:       result[PB.CONFIG.SESSION_KEYS.SUPPRESSED]         || false,
    aiMessageCount:   result[PB.CONFIG.SESSION_KEYS.AI_MSG_COUNT]       || 0
  };

  console.log('[PeerBridge:storage] getSessionState:', state);
  return state;
};

/**
 * incrementDismissalCount
 * Increments dismissal counter. Sets suppressed=true if threshold reached (FR-14).
 * @returns {Promise<{dismissalCount: number, suppressed: boolean}>}
 */
PB.incrementDismissalCount = async function () {
  const state      = await PB.getSessionState();
  const newCount   = state.dismissalCount + 1;
  const suppressed = newCount >= PB.CONFIG.MAX_DISMISSALS_PER_SESSION;

  await chrome.storage.session.set({
    [PB.CONFIG.SESSION_KEYS.DISMISSAL_COUNT]: newCount,
    [PB.CONFIG.SESSION_KEYS.SUPPRESSED]:      suppressed
  });

  console.log('[PeerBridge:storage] incrementDismissalCount:', newCount, '| suppressed:', suppressed);
  return { dismissalCount: newCount, suppressed };
};

/**
 * incrementSuggestionCount
 * Records that a suggestion was shown. Saves timestamp for cooldown enforcement (FR-15).
 */
PB.incrementSuggestionCount = async function () {
  const state = await PB.getSessionState();
  const newCount = state.suggestionCount + 1;

  await chrome.storage.session.set({
    [PB.CONFIG.SESSION_KEYS.SUGGESTION_COUNT]:   newCount,
    [PB.CONFIG.SESSION_KEYS.LAST_SUGGESTION_TS]: Date.now()
  });

  console.log('[PeerBridge:storage] incrementSuggestionCount:', newCount);
};

/**
 * incrementAiMessageCount
 * Tracks how many messages the user has sent in the current AI chat session (FR-03).
 * @returns {Promise<number>} new count
 */
PB.incrementAiMessageCount = async function () {
  const state    = await PB.getSessionState();
  const newCount = state.aiMessageCount + 1;

  await chrome.storage.session.set({
    [PB.CONFIG.SESSION_KEYS.AI_MSG_COUNT]: newCount
  });

  console.log('[PeerBridge:storage] incrementAiMessageCount:', newCount);
  return newCount;
};

/**
 * canShowSuggestion
 * Master gate — checks all session limits and pause state before showing a card.
 * Called by the SW before every potential card display.
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
PB.canShowSuggestion = async function () {
  console.log('[PeerBridge:storage] canShowSuggestion — checking all gates');

  const [state, paused] = await Promise.all([
    PB.getSessionState(),
    PB.isPausedForToday()
  ]);

  if (paused) {
    console.log('[PeerBridge:storage] canShowSuggestion: BLOCKED — paused for today');
    return { allowed: false, reason: 'paused_for_today' };
  }

  if (state.suppressed) {
    console.log('[PeerBridge:storage] canShowSuggestion: BLOCKED — session suppressed (3 dismissals)');
    return { allowed: false, reason: 'session_suppressed' };
  }

  if (state.suggestionCount >= PB.CONFIG.MAX_SUGGESTIONS_PER_SESSION) {
    console.log('[PeerBridge:storage] canShowSuggestion: BLOCKED — session limit reached');
    return { allowed: false, reason: 'session_limit' };
  }

  if (state.lastSuggestionTs) {
    const elapsed   = Date.now() - state.lastSuggestionTs;
    const remaining = PB.CONFIG.SUGGESTION_COOLDOWN_MS - elapsed;
    if (remaining > 0) {
      console.log('[PeerBridge:storage] canShowSuggestion: BLOCKED — cooldown active, remaining:', Math.ceil(remaining / 1000) + 's');
      return { allowed: false, reason: 'cooldown', remainingMs: remaining };
    }
  }

  console.log('[PeerBridge:storage] canShowSuggestion: ALLOWED');
  return { allowed: true };
};

console.log('[PeerBridge] storage.js loaded — all storage functions ready on PB namespace.');
