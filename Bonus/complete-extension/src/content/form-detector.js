/**
 * =============================================================================
 * FILE: src/content/form-detector.js
 * PURPOSE: Detects form-heavy pages and triggers peer suggestion when both
 *          the field count (5+) and time threshold (60s) conditions are met.
 * RUNS ON: All https pages (second content_scripts entry in manifest.json)
 * DEPENDS ON: shared/constants.js (window.PB.CONFIG, window.PB.MESSAGES)
 * MV3 NOTE: Plain JS IIFE — no import/export.
 * FR COVERAGE: FR-04, FR-05 (counts fields, NEVER reads values)
 * NFR COVERAGE: NFR-01 (uses requestIdleCallback to avoid blocking page load)
 * =============================================================================
 */

(function () {
  'use strict';

  var CONFIG   = window.PB.CONFIG;
  var MESSAGES = window.PB.MESSAGES;

  console.log('[PeerBridge:FormDetector] form-detector.js loaded on:', location.hostname);

  // Prevent firing more than once per page
  var formTriggered      = false;
  // Timer reference for the 60s threshold
  var timeThresholdTimer = null;
  // Debounce timer for DOM mutation observer
  var mutationDebounce   = null;

  // =============================================================================
  // PAGE CONTEXT — PII-safe (FR-05)
  // Only reads page title and URL path — never form field values.
  // =============================================================================

  /**
   * getSafePageContext
   * Returns page title and a sanitised URL path for context scoring.
   * Strips numeric IDs and UUID segments from the path to prevent PII leakage.
   * @returns {{ pageTitle: string, pageUrl: string }}
   */
  function getSafePageContext() {
    var title = (document.title || '').substring(0, 80);

    // Strip ID-like path segments — UUIDs, numeric IDs (FR-05)
    var safePath = location.pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '/[uuid]') // UUID pattern
      .replace(/\/[0-9a-f-]{8,}/gi, '/[id]')                // Long hex IDs
      .replace(/\/\d+/g, '/[num]')                           // Numeric IDs
      .substring(0, 100);

    var context = {
      pageTitle: title,
      pageUrl:   location.hostname + safePath
    };

    console.log('[PeerBridge:FormDetector] getSafePageContext:', context);
    return context;
  }

  // =============================================================================
  // FIELD COUNTER (FR-04, FR-05)
  // Counts VISIBLE, INTERACTIVE form fields.
  // NEVER accesses .value — structure only.
  // =============================================================================

  /**
   * countFormFields
   * Counts visible, interactive form fields on the page.
   * Excludes: hidden inputs, submit/button/reset inputs, disabled fields.
   * Includes: text inputs, selects, textareas — the fields a user fills in.
   * @returns {number}
   */
  function countFormFields() {
    // Select all potentially interactive fields (FR-05: no .value access)
    var candidates = document.querySelectorAll(
      'input:not([type="hidden"])' +
      ':not([type="submit"])' +
      ':not([type="button"])' +
      ':not([type="reset"])' +
      ':not([disabled]),' +
      'select:not([disabled]),' +
      'textarea:not([disabled])'
    );

    var visibleCount = 0;

    for (var i = 0; i < candidates.length; i++) {
      var el    = candidates[i];
      var style = window.getComputedStyle(el);
      // Only count actually visible fields
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        visibleCount++;
      }
    }

    console.log('[PeerBridge:FormDetector] countFormFields:', visibleCount, 'visible fields');
    return visibleCount;
  }

  // =============================================================================
  // TRIGGER LOGIC (FR-04)
  // Both conditions must be true: fieldCount >= 5 AND time >= 60s.
  // =============================================================================

  /**
   * checkAndMaybeTrigger
   * Checks field count. If >= threshold, starts the 60s timer.
   * When timer fires, re-checks field count and sends to SW if still met.
   */
  function checkAndMaybeTrigger() {
    if (formTriggered) return;

    var fieldCount = countFormFields();

    if (fieldCount < CONFIG.FORM_FIELD_THRESHOLD) {
      console.log('[PeerBridge:FormDetector] Field count', fieldCount, '< threshold', CONFIG.FORM_FIELD_THRESHOLD, '— waiting');
      return;
    }

    // Field threshold met — start time threshold timer if not already running
    if (timeThresholdTimer) return;

    console.log('[PeerBridge:FormDetector] Field threshold met (', fieldCount, ') — starting', CONFIG.FORM_TIME_THRESHOLD_MS / 1000 + 's timer');

    timeThresholdTimer = setTimeout(function () {
      if (formTriggered) return;

      // Re-check field count — user may have navigated away or fields were removed
      var currentFieldCount = countFormFields();

      if (currentFieldCount < CONFIG.FORM_FIELD_THRESHOLD) {
        console.log('[PeerBridge:FormDetector] Field count dropped below threshold — cancelling');
        timeThresholdTimer = null;
        return;
      }

      formTriggered = true;
      console.log('[PeerBridge:FormDetector] BOTH thresholds met — notifying SW. fields:', currentFieldCount, '| time: 60s');

      var context = getSafePageContext();

      // Send to SW — SW will score and decide whether to show card
      try {
        chrome.runtime.sendMessage({
          type: MESSAGES.FORM_THRESHOLD_MET,
          payload: {
            fieldCount:  currentFieldCount,
            timeSpentMs: CONFIG.FORM_TIME_THRESHOLD_MS,
            pageTitle:   context.pageTitle,
            pageUrl:     context.pageUrl
          }
        }, function (response) {
          if (chrome.runtime.lastError) {
            console.warn('[PeerBridge:FormDetector] sendMessage error:', chrome.runtime.lastError.message);
            return;
          }
          console.log('[PeerBridge:FormDetector] SW response:', response);
          // Note: Form detector only sends the signal.
          // Card injection is handled by content-main.js via SW → CS message.
          // But form-detector runs on ALL pages — content-main only runs on target pages.
          // For form pages that aren't AI/search pages, we handle card injection here:
          if (response && response.show) {
            var card = new window.PB.SuggestionCard({
              matchData:    response.matchData,
              pageType:     response.pageType,
              autoDissmiss: false,
              onConnect: function (matchId, contextToken) {
                var url = CONFIG.PEER_CONNECTION_BASE_URL +
                  '?match_id='      + encodeURIComponent(matchId) +
                  '&context_token=' + encodeURIComponent(contextToken);
                chrome.runtime.sendMessage({ type: MESSAGES.OPEN_TAB, payload: { url: url } });
              },
              onDismiss: function (reason) {
                chrome.runtime.sendMessage({ type: MESSAGES.DISMISS_CARD, payload: { reason: reason } });
              },
              onPauseForToday: function () {
                chrome.runtime.sendMessage({ type: MESSAGES.PAUSE_FOR_TODAY, payload: {} });
              }
            });
            card.mount();
          }
        });
      } catch (err) {
        // NFR-05: Fail silently — extension context may be invalidated
        console.warn('[PeerBridge:FormDetector] Failed to send message (NFR-05):', err.message);
      }

    }, CONFIG.FORM_TIME_THRESHOLD_MS);
  }

  // =============================================================================
  // DOM MUTATION OBSERVER
  // Catches dynamically added form fields (SPA multi-step forms).
  // =============================================================================

  var formObserver = new MutationObserver(function () {
    clearTimeout(mutationDebounce);
    mutationDebounce = setTimeout(function () {
      if (!formTriggered) {
        console.log('[PeerBridge:FormDetector] DOM mutation — re-checking field count');
        checkAndMaybeTrigger();
      }
    }, 1000); // Debounce 1s — SPA transitions can cause many rapid mutations
  });

  // =============================================================================
  // INIT — deferred via requestIdleCallback (NFR-01)
  // requestIdleCallback ensures field counting runs only when browser is idle,
  // adding zero measurable overhead to page load time.
  // =============================================================================

  function init() {
    console.log('[PeerBridge:FormDetector] init — starting field detection');
    checkAndMaybeTrigger();
    formObserver.observe(document.body, { childList: true, subtree: true });
    console.log('[PeerBridge:FormDetector] MutationObserver watching for form field changes');
  }

  if ('requestIdleCallback' in window) {
    // NFR-01: Run during browser idle time — no impact on page load
    requestIdleCallback(init, { timeout: 2000 });
    console.log('[PeerBridge:FormDetector] Scheduled via requestIdleCallback');
  } else {
    // Fallback for browsers without requestIdleCallback
    setTimeout(init, 500);
    console.log('[PeerBridge:FormDetector] Scheduled via setTimeout fallback');
  }

})();
