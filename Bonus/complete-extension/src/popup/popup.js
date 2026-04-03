/**
 * =============================================================================
 * FILE: src/popup/popup.js
 * PURPOSE: All JS logic for the popup UI.
 *          Handles onboarding flow routing, settings persistence,
 *          frequency control, goal context CRUD, and pause toggle.
 * USED BY: popup.html via <script src="popup.js">
 * NOTE: Cannot use chrome.storage.session here — popup runs in a different
 *       context from the SW. Uses chrome.storage.local for all persistence.
 *       For session state reads, sends messages to SW.
 * FR COVERAGE: FR-16, FR-17, FR-18, FR-19, FR-20, FR-22, FR-23, US-01,
 *              US-05, US-06
 * =============================================================================
 */

'use strict';

console.log('[PeerBridge:Popup] popup.js loaded');

// =============================================================================
// STORAGE KEYS — must match shared/constants.js
// Popup can't importScripts, so we define the keys inline here.
// These are kept identical to PB.CONFIG.STORAGE_KEYS.
// =============================================================================
var KEYS = {
  GOAL_CONTEXT:    'pb_goal_context',
  GOAL_CONTEXT_IV: 'pb_goal_context_iv',
  OPT_IN:          'pb_opt_in',
  ONBOARDING_DONE: 'pb_onboarding_done',
  FREQUENCY:       'pb_frequency',
  PAUSED_UNTIL:    'pb_paused_until',
  CRYPTO_KEY:      'pb_crypto_key'
};

var FREQUENCY = {
  ACTIVE:  'active',
  REDUCED: 'reduced',
  PAUSED:  'paused'
};

// Frequency hint text per mode
var FREQ_HINTS = {
  active:  'Active: up to 2 suggestions per session',
  reduced: 'Reduced: max 1 suggestion per session',
  paused:  'Paused: no suggestions until you re-enable'
};

// =============================================================================
// VIEW ROUTING
// =============================================================================

/**
 * showView
 * Switches between onboarding and settings views.
 * @param {string} viewId - 'view-onboarding' | 'view-settings'
 */
function showView(viewId) {
  console.log('[PeerBridge:Popup] showView:', viewId);
  document.querySelectorAll('.view').forEach(function (v) {
    v.classList.toggle('hidden', v.id !== viewId);
  });
}

/**
 * initView
 * On popup open: check storage to decide which view to show.
 * If onboarding not done → show onboarding.
 * If onboarding done → show settings.
 * URL param ?onboarding=true forces onboarding (used on first install).
 */
function initView() {
  console.log('[PeerBridge:Popup] initView — checking onboarding status');

  var params      = new URLSearchParams(window.location.search);
  var forceOnboard = params.get('onboarding') === 'true';

  chrome.storage.local.get(KEYS.ONBOARDING_DONE, function (result) {
    var done = !!result[KEYS.ONBOARDING_DONE];
    console.log('[PeerBridge:Popup] onboarding done:', done, '| forceOnboard:', forceOnboard);

    if (!done || forceOnboard) {
      showView('view-onboarding');
    } else {
      showView('view-settings');
      loadSettings();
    }
  });
}

// =============================================================================
// ONBOARDING FLOW (FR-16, FR-17, FR-18, US-01)
// =============================================================================

var currentStep = 1;

/**
 * goToStep
 * Navigates to the specified onboarding step.
 * Updates progress dots accordingly.
 * @param {number} step - 1 | 2 | 3
 */
function goToStep(step) {
  console.log('[PeerBridge:Popup] goToStep:', step);

  // Hide all steps
  document.querySelectorAll('.step').forEach(function (s) {
    s.classList.remove('active');
  });

  // Show target step
  var targetStep = document.getElementById('step-' + step);
  if (targetStep) targetStep.classList.add('active');

  // Update progress dots
  [1, 2, 3].forEach(function (i) {
    var dot = document.getElementById('dot-' + i);
    if (!dot) return;
    dot.className = 'progress__dot';
    if (i < step)  dot.classList.add('done');
    if (i === step) dot.classList.add('active');
  });

  currentStep = step;

  // Move focus to step heading for accessibility
  var heading = targetStep && targetStep.querySelector('h1, h2');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
}

/**
 * completeOnboarding
 * Called when user clicks Done on step 3 or skips entirely.
 * Marks onboarding complete in storage, switches to settings view.
 */
function completeOnboarding() {
  console.log('[PeerBridge:Popup] completeOnboarding');

  chrome.storage.local.set({
    [KEYS.ONBOARDING_DONE]: true,
    [KEYS.OPT_IN]: true
  }, function () {
    console.log('[PeerBridge:Popup] Onboarding complete — switching to settings');
    showView('view-settings');
    loadSettings();
  });
}

// Step 1 → Step 2
document.getElementById('step1-next').addEventListener('click', function () {
  console.log('[PeerBridge:Popup] step1-next clicked');
  goToStep(2);
});

// Step 1 → Skip → Done (FR-18: skippable at any point)
document.getElementById('step1-skip').addEventListener('click', function () {
  console.log('[PeerBridge:Popup] step1-skip clicked — skipping onboarding');
  completeOnboarding();
});

// Step 2 → Step 3 (save goal context if provided)
document.getElementById('step2-next').addEventListener('click', function () {
  console.log('[PeerBridge:Popup] step2-next clicked');
  var val = document.getElementById('goal-input').value.trim();
  if (val) {
    saveGoalContextRaw(val, function () {
      goToStep(3);
    });
  } else {
    goToStep(3);
  }
});

// Step 2 → Skip
document.getElementById('step2-skip').addEventListener('click', function () {
  console.log('[PeerBridge:Popup] step2-skip clicked');
  goToStep(3);
});

// Step 3 → Done
document.getElementById('step3-done').addEventListener('click', function () {
  console.log('[PeerBridge:Popup] step3-done clicked');
  completeOnboarding();
});

// Character counter for onboarding textarea
document.getElementById('goal-input').addEventListener('input', function () {
  var len = this.value.length;
  var countEl = document.getElementById('char-count');
  var hintEl  = document.querySelector('.char-hint');
  if (countEl) countEl.textContent = len;
  if (hintEl)  hintEl.classList.toggle('warn', len > 180);
  console.log('[PeerBridge:Popup] Goal input length:', len);
});

// =============================================================================
// SETTINGS — LOAD (FR-20, US-05, US-06)
// =============================================================================

/**
 * loadSettings
 * Reads all preferences from storage and populates the settings UI.
 * Called when switching to settings view.
 */
function loadSettings() {
  console.log('[PeerBridge:Popup] loadSettings');

  chrome.storage.local.get([
    KEYS.FREQUENCY,
    KEYS.PAUSED_UNTIL,
    KEYS.GOAL_CONTEXT,
    KEYS.GOAL_CONTEXT_IV,
    KEYS.CRYPTO_KEY
  ], function (result) {
    // Frequency
    var freq = result[KEYS.FREQUENCY] || FREQUENCY.ACTIVE;
    setFrequencyUI(freq);
    console.log('[PeerBridge:Popup] Loaded frequency:', freq);

    // Pause state
    var pausedUntil = result[KEYS.PAUSED_UNTIL];
    var isPaused    = pausedUntil && Date.now() < pausedUntil;
    updatePauseToggleUI(isPaused);
    console.log('[PeerBridge:Popup] Loaded pause state:', isPaused);

    // Goal context — decrypt and display
    var ciphertext = result[KEYS.GOAL_CONTEXT];
    var iv         = result[KEYS.GOAL_CONTEXT_IV];
    var cryptoKey  = result[KEYS.CRYPTO_KEY];

    if (ciphertext && iv && cryptoKey) {
      decryptGoalContext(ciphertext, iv, cryptoKey, function (plaintext) {
        updateGoalDisplay(plaintext);
        console.log('[PeerBridge:Popup] Goal context decrypted and displayed');
      });
    } else {
      updateGoalDisplay(null);
      console.log('[PeerBridge:Popup] No goal context stored');
    }
  });
}

/**
 * updateGoalDisplay
 * Updates the goal context display element with current value.
 * @param {string|null} value
 */
function updateGoalDisplay(value) {
  var el = document.getElementById('goal-display-text');
  if (!el) return;

  if (value) {
    el.textContent = value;
    el.classList.remove('goal-display__text--empty');
  } else {
    el.textContent = 'No goal context set — click to add one';
    el.classList.add('goal-display__text--empty');
  }
}

// =============================================================================
// PAUSE TOGGLE (FR-22, FR-23)
// =============================================================================

/**
 * updatePauseToggleUI
 * Updates the toggle button visual state and aria-checked.
 * FR-22: Greyed badge shown when paused — badge is managed by SW.
 * @param {boolean} paused
 */
function updatePauseToggleUI(paused) {
  var toggle = document.getElementById('pause-toggle');
  if (!toggle) return;

  // aria-checked="true" = active (NOT paused), "false" = paused
  toggle.setAttribute('aria-checked', paused ? 'false' : 'true');
  toggle.setAttribute('aria-label',
    paused
      ? 'PeerBridge paused — click to resume'
      : 'PeerBridge active — click to pause'
  );
  console.log('[PeerBridge:Popup] Pause toggle UI:', paused ? 'PAUSED' : 'ACTIVE');
}

document.getElementById('pause-toggle').addEventListener('click', function () {
  var isCurrentlyActive = this.getAttribute('aria-checked') === 'true';
  console.log('[PeerBridge:Popup] Pause toggle clicked — currently active:', isCurrentlyActive);

  if (isCurrentlyActive) {
    // Pause for today
    var endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    chrome.storage.local.set({ [KEYS.PAUSED_UNTIL]: endOfDay.getTime() }, function () {
      updatePauseToggleUI(true);
      console.log('[PeerBridge:Popup] Paused until end of day');
      // FR-23: Notify SW to update badge and remove any active card
      chrome.runtime.sendMessage({ type: 'PAUSE_FOR_TODAY', payload: {} });
    });
  } else {
    // Resume
    chrome.storage.local.remove(KEYS.PAUSED_UNTIL, function () {
      updatePauseToggleUI(false);
      console.log('[PeerBridge:Popup] Resumed — pause cleared');
      chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', payload: {} });
    });
  }
});

// =============================================================================
// FREQUENCY CONTROL (FR-20, FR-23)
// =============================================================================

/**
 * setFrequencyUI
 * Updates the segmented control to reflect current frequency setting.
 * @param {string} freq - 'active' | 'reduced' | 'paused'
 */
function setFrequencyUI(freq) {
  document.querySelectorAll('.freq-btn').forEach(function (btn) {
    var isActive = btn.dataset.freq === freq;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });

  var hint = document.getElementById('freq-hint');
  if (hint) hint.textContent = FREQ_HINTS[freq] || '';
  console.log('[PeerBridge:Popup] Frequency UI set to:', freq);
}

// Frequency button click handler
document.querySelectorAll('.freq-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var freq = this.dataset.freq;
    console.log('[PeerBridge:Popup] Frequency changed to:', freq);

    // FR-23: Save immediately — takes effect without page reload
    chrome.storage.local.set({ [KEYS.FREQUENCY]: freq }, function () {
      setFrequencyUI(freq);
      // Notify SW to update badge if needed
      chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', payload: {} });
    });
  });
});

// =============================================================================
// GOAL CONTEXT EDIT (FR-20, US-06)
// =============================================================================

var goalDisplay  = document.getElementById('goal-display');
var goalEditArea = document.getElementById('goal-edit-area');
var goalEditInput = document.getElementById('goal-edit-input');

/**
 * openGoalEdit
 * Switches from display mode to edit mode.
 * Pre-populates textarea with current (decrypted) value.
 */
function openGoalEdit() {
  console.log('[PeerBridge:Popup] openGoalEdit');

  // Load current decrypted value into textarea
  chrome.storage.local.get([KEYS.GOAL_CONTEXT, KEYS.GOAL_CONTEXT_IV, KEYS.CRYPTO_KEY], function (result) {
    var ciphertext = result[KEYS.GOAL_CONTEXT];
    var iv         = result[KEYS.GOAL_CONTEXT_IV];
    var key        = result[KEYS.CRYPTO_KEY];

    function showEditArea(value) {
      goalEditInput.value = value || '';
      updateGoalEditCount();
      goalDisplay.style.display  = 'none';
      goalEditArea.removeAttribute('hidden');
      goalEditInput.focus();
    }

    if (ciphertext && iv && key) {
      decryptGoalContext(ciphertext, iv, key, showEditArea);
    } else {
      showEditArea('');
    }
  });
}

goalDisplay.addEventListener('click', openGoalEdit);
goalDisplay.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGoalEdit(); }
});

// Character counter for settings edit textarea
goalEditInput.addEventListener('input', updateGoalEditCount);

function updateGoalEditCount() {
  var len = goalEditInput.value.length;
  var countEl = document.getElementById('goal-edit-count');
  if (countEl) countEl.textContent = len;
  console.log('[PeerBridge:Popup] Goal edit input length:', len);
}

// Save goal context
document.getElementById('goal-save').addEventListener('click', function () {
  var val = goalEditInput.value.trim();
  console.log('[PeerBridge:Popup] Saving goal context — length:', val.length);

  if (val) {
    saveGoalContextRaw(val, function () {
      updateGoalDisplay(val);
      closeGoalEdit();
      showConfirmToast();
    });
  } else {
    // Empty = clear context
    clearGoalContext(function () {
      updateGoalDisplay(null);
      closeGoalEdit();
      showConfirmToast();
    });
  }
});

// Clear goal context
document.getElementById('goal-clear').addEventListener('click', function () {
  console.log('[PeerBridge:Popup] Clearing goal context');
  goalEditInput.value = '';
  updateGoalEditCount();
});

// Cancel edit
document.getElementById('goal-cancel').addEventListener('click', function () {
  console.log('[PeerBridge:Popup] Goal edit cancelled');
  closeGoalEdit();
});

/**
 * closeGoalEdit
 * Switches back from edit mode to display mode.
 */
function closeGoalEdit() {
  goalDisplay.style.display = '';
  goalEditArea.setAttribute('hidden', '');
  goalDisplay.focus();
}

/**
 * showConfirmToast
 * Shows the "Your goal context has been updated." confirmation (US-06).
 * Auto-hides after 3 seconds.
 */
function showConfirmToast() {
  var toast = document.getElementById('confirm-toast');
  if (!toast) return;
  toast.classList.add('visible');
  setTimeout(function () { toast.classList.remove('visible'); }, 3000);
  console.log('[PeerBridge:Popup] Confirmation toast shown');
}

// =============================================================================
// WEB CRYPTO — AES-GCM (FR-19)
// Popup handles its own crypto operations since it can't use importScripts.
// These are identical to the functions in shared/storage.js.
// =============================================================================

/**
 * getOrCreatePopupCryptoKey
 * Retrieves or creates the AES-GCM key from storage.
 * @param {function} callback - (CryptoKey) => void
 */
function getOrCreatePopupCryptoKey(callback) {
  chrome.storage.local.get(KEYS.CRYPTO_KEY, function (result) {
    var rawKeyData = result[KEYS.CRYPTO_KEY];

    if (rawKeyData) {
      crypto.subtle.importKey(
        'raw',
        new Uint8Array(rawKeyData),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      ).then(callback).catch(function (err) {
        console.error('[PeerBridge:Popup] Key import failed:', err);
      });
    } else {
      crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      ).then(function (key) {
        crypto.subtle.exportKey('raw', key).then(function (rawKey) {
          chrome.storage.local.set({ [KEYS.CRYPTO_KEY]: Array.from(new Uint8Array(rawKey)) });
          callback(key);
        });
      });
    }
  });
}

/**
 * saveGoalContextRaw
 * Encrypts and saves goal context (FR-19).
 * @param {string} plaintext
 * @param {function} [onDone]
 */
function saveGoalContextRaw(plaintext, onDone) {
  console.log('[PeerBridge:Popup] saveGoalContextRaw — encrypting');

  getOrCreatePopupCryptoKey(function (key) {
    var iv      = crypto.getRandomValues(new Uint8Array(12));
    var encoded = new TextEncoder().encode(plaintext);

    crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, encoded).then(function (cipher) {
      chrome.storage.local.set({
        [KEYS.GOAL_CONTEXT]:    Array.from(new Uint8Array(cipher)),
        [KEYS.GOAL_CONTEXT_IV]: Array.from(iv)
      }, function () {
        console.log('[PeerBridge:Popup] Goal context saved encrypted');
        if (onDone) onDone();
      });
    }).catch(function (err) {
      console.error('[PeerBridge:Popup] Encryption failed:', err);
    });
  });
}

/**
 * clearGoalContext
 * Removes stored goal context entirely.
 * @param {function} [onDone]
 */
function clearGoalContext(onDone) {
  console.log('[PeerBridge:Popup] clearGoalContext');
  chrome.storage.local.remove([KEYS.GOAL_CONTEXT, KEYS.GOAL_CONTEXT_IV], function () {
    console.log('[PeerBridge:Popup] Goal context cleared');
    if (onDone) onDone();
  });
}

/**
 * decryptGoalContext
 * Decrypts stored goal context for display.
 * @param {number[]} ciphertext
 * @param {number[]} iv
 * @param {number[]} rawKey
 * @param {function} callback - (plaintext: string) => void
 */
function decryptGoalContext(ciphertext, iv, rawKey, callback) {
  crypto.subtle.importKey(
    'raw',
    new Uint8Array(rawKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  ).then(function (key) {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(ciphertext)
    );
  }).then(function (decrypted) {
    var plaintext = new TextDecoder().decode(decrypted);
    console.log('[PeerBridge:Popup] Goal context decrypted');
    callback(plaintext);
  }).catch(function (err) {
    console.warn('[PeerBridge:Popup] Decryption failed:', err);
    callback(null);
  });
}

// =============================================================================
// INIT
// =============================================================================
initView();
