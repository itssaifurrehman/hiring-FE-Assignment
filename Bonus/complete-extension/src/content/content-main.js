/**
 * =============================================================================
 * FILE: src/content/content-main.js
 * PURPOSE: Main content script for target pages (Google, Bing, AI chats).
 *          Detects page type, extracts anonymised signals, sends to SW for
 *          scoring, and mounts the suggestion card when SW responds with show:true.
 * RUNS ON: Google Search, Bing, ChatGPT, Claude.ai, Gemini (see manifest.json)
 * DEPENDS ON: shared/constants.js (window.PB.CONFIG, window.PB.MESSAGES)
 *             src/components/suggestion-card.js (window.PB.SuggestionCard)
 * MV3 NOTE: Plain JS IIFE — no import/export. Loaded in order via manifest.
 * FR COVERAGE: FR-01, FR-02, FR-03, FR-06, FR-07, FR-08, FR-12, FR-13, FR-23, FR-24
 * =============================================================================
 */

(function () {
  'use strict';

  var CONFIG   = window.PB.CONFIG;
  var MESSAGES = window.PB.MESSAGES;

  console.log('[PeerBridge:Content] content-main.js loaded on:', location.hostname);

  // Track whether we've already shown a card this page load
  var cardInjected            = false;
  // Reference to active card instance (for external removal)
  var activeCard              = null;
  // Prevent multiple AI chat cards in one session
  var chatCardShownThisSession = false;

  // =============================================================================
  // PAGE TYPE DETECTION (FR-01)
  // =============================================================================

  /**
   * detectPageType
   * Identifies which supported page type we're on.
   * Returns PAGE_TYPE constant matching current URL.
   * @returns {string} one of CONFIG.PAGE_TYPE values
   */
  function detectPageType() {
    var host = location.hostname;
    var path = location.pathname;

    if (host === CONFIG.TARGET_HOSTS.GOOGLE && path.indexOf('/search') === 0) {
      console.log('[PeerBridge:Content] Page type: SEARCH (Google)');
      return CONFIG.PAGE_TYPE.SEARCH;
    }

    if (host === CONFIG.TARGET_HOSTS.BING && path.indexOf('/search') === 0) {
      console.log('[PeerBridge:Content] Page type: SEARCH (Bing)');
      return CONFIG.PAGE_TYPE.SEARCH;
    }

    if (CONFIG.TARGET_HOSTS.CHATGPT.indexOf(host) !== -1) {
      console.log('[PeerBridge:Content] Page type: AI_CHAT (ChatGPT)');
      return CONFIG.PAGE_TYPE.AI_CHAT;
    }

    if (host === CONFIG.TARGET_HOSTS.CLAUDE) {
      console.log('[PeerBridge:Content] Page type: AI_CHAT (Claude)');
      return CONFIG.PAGE_TYPE.AI_CHAT;
    }

    if (host === CONFIG.TARGET_HOSTS.GEMINI) {
      console.log('[PeerBridge:Content] Page type: AI_CHAT (Gemini)');
      return CONFIG.PAGE_TYPE.AI_CHAT;
    }

    console.log('[PeerBridge:Content] Page type: UNKNOWN —', host);
    return CONFIG.PAGE_TYPE.UNKNOWN;
  }

  // =============================================================================
  // SIGNAL EXTRACTORS — never read PII, form values, or auth tokens (FR-05)
  // =============================================================================

  /**
   * extractSearchContext
   * Reads query from URL only — never page content.
   * Strips emails and long numbers before sending to SW.
   * @returns {{ query: string }}
   */
  function extractSearchContext() {
    var params = new URLSearchParams(location.search);
    var query  = params.get('q') || params.get('query') || params.get('search') || '';

    // Anonymise: strip emails and numeric identifiers (FR-05)
    var clean = query
      .replace(/[\w.-]+@[\w.-]+\.\w+/g, '')
      .replace(/\b\d{5,}\b/g, '')
      .trim();

    console.log('[PeerBridge:Content] extractSearchContext — query:', clean.substring(0, 60));
    return { query: clean };
  }

  /**
   * AI_CHAT_SELECTORS
   * DOM selectors for user messages on each AI chat platform.
   * RISK: These selectors break when AI platforms update their DOM.
   * Mitigation: Multiple fallback selectors, silent failure if none match.
   */
  var AI_CHAT_SELECTORS = {
    'chat.openai.com':  '[data-message-author-role="user"]',
    'chatgpt.com':      '[data-message-author-role="user"]',
    'claude.ai':        '[data-testid="human-turn"], .human-turn, [class*="humanTurn"]',
    'gemini.google.com':'user-query, .query-text, [class*="user-query"]'
  };

  /**
   * extractAIChatContext
   * Reads message count and recent message text (anonymised).
   * Never reads AI responses — only user messages.
   * @returns {{ messageCount, recentMessages, sessionDurationMs }}
   */
  function extractAIChatContext() {
    var host     = location.hostname;
    var selector = AI_CHAT_SELECTORS[host];

    if (!selector) {
      console.warn('[PeerBridge:Content] No selector for host:', host);
      return { messageCount: 0, recentMessages: [], sessionDurationMs: 0 };
    }

    var messageEls   = document.querySelectorAll(selector);
    var messageCount = messageEls.length;

    // Get last 3 messages, anonymised
    var recent = Array.prototype.slice.call(messageEls)
      .slice(-3)
      .map(function (el) {
        var text = (el.textContent || '').trim();
        // Anonymise: strip emails and phone numbers (FR-05)
        return text
          .replace(/[\w.-]+@[\w.-]+/g, '[email]')
          .replace(/\b\d{10,}\b/g, '[num]')
          .substring(0, 200);
      })
      .filter(Boolean);

    console.log('[PeerBridge:Content] extractAIChatContext — messageCount:', messageCount, '| recent:', recent.length, 'messages');

    return {
      messageCount:    messageCount,
      recentMessages:  recent,
      sessionDurationMs: performance.now() // Proxy for session age
    };
  }

  // =============================================================================
  // MESSAGING — content script → service worker
  // =============================================================================

  /**
   * sendToBackground
   * Sends a message to the SW and returns the response via callback.
   * Handles chrome.runtime.lastError silently (context may be invalidated).
   * @param {string} type - MESSAGES constant
   * @param {object} payload
   * @param {function} [callback]
   */
  function sendToBackground(type, payload, callback) {
    console.log('[PeerBridge:Content] sendToBackground:', type, '| payload:', payload);

    try {
      chrome.runtime.sendMessage({ type: type, payload: payload }, function (response) {
        if (chrome.runtime.lastError) {
          console.warn('[PeerBridge:Content] sendMessage error:', chrome.runtime.lastError.message);
          return;
        }
        console.log('[PeerBridge:Content] Response from SW for', type, ':', response);
        if (callback) callback(response);
      });
    } catch (err) {
      console.warn('[PeerBridge:Content] sendToBackground failed:', err.message);
    }
  }

  // =============================================================================
  // CARD INJECTION
  // =============================================================================

  /**
   * maybeShowCard
   * Receives SW response and mounts the card if show:true.
   * FR-08: Card must render within 1s — all assets are pre-bundled.
   * @param {object} response - SW scoring response
   */
  function maybeShowCard(response) {
    console.log('[PeerBridge:Content] maybeShowCard — response:', response);

    if (!response || !response.show) {
      console.log('[PeerBridge:Content] Not showing card — reason:', response && response.reason);
      return;
    }

    if (cardInjected) {
      console.log('[PeerBridge:Content] Card already injected — skipping');
      return;
    }

    cardInjected = true;
    console.log('[PeerBridge:Content] Mounting card — score:', response.score, '| peer:', response.matchData && response.matchData.matchId);

    activeCard = new window.PB.SuggestionCard({
      matchData:    response.matchData,
      pageType:     response.pageType,
      autoDissmiss: response.autoDissmiss,

      // FR-24: Build connect URL with match_id and context_token
      onConnect: function (matchId, contextToken) {
        var url = CONFIG.PEER_CONNECTION_BASE_URL +
          '?match_id='      + encodeURIComponent(matchId) +
          '&context_token=' + encodeURIComponent(contextToken);
        console.log('[PeerBridge:Content] Connect — opening URL:', url);
        // MV3: content scripts cannot call chrome.tabs.create — delegate to SW
        sendToBackground(MESSAGES.OPEN_TAB, { url: url });
      },

      // FR-13: Dismiss immediately, notify SW to update session state
      onDismiss: function (reason) {
        console.log('[PeerBridge:Content] Card dismissed — reason:', reason);
        cardInjected = false;
        activeCard   = null;
        sendToBackground(MESSAGES.DISMISS_CARD, { reason: reason });
      },

      // FR-21: Pause for today from the card itself
      onPauseForToday: function () {
        console.log('[PeerBridge:Content] Pause for today triggered from card');
        cardInjected = false;
        activeCard   = null;
        sendToBackground(MESSAGES.PAUSE_FOR_TODAY, {});
      }
    });

    activeCard.mount();
  }

  // =============================================================================
  // SEARCH PAGE HANDLER (FR-01, FR-02)
  // =============================================================================

  /**
   * handleSearchPage
   * Extracts search query and sends to SW for scoring.
   * Delayed 300ms to let search results fully render before evaluating.
   */
  function handleSearchPage() {
    console.log('[PeerBridge:Content] handleSearchPage — waiting for results to render');

    setTimeout(function () {
      var context = extractSearchContext();

      if (!context.query) {
        console.log('[PeerBridge:Content] handleSearchPage — empty query, skipping');
        return;
      }

      sendToBackground(MESSAGES.SCORE_CONTEXT, {
        pageType: CONFIG.PAGE_TYPE.SEARCH,
        query:    context.query
      }, maybeShowCard);

    }, 300);
  }

  // =============================================================================
  // AI CHAT HANDLER (FR-01, FR-03)
  // =============================================================================

  var lastObservedMessageCount = 0;
  var aiDebounceTimer          = null;

  /**
   * observeAIChatMessages
   * Watches for new user messages using MutationObserver.
   * Debounced to avoid excessive SW messages during rapid DOM updates.
   * When message count increases, sends AI_MESSAGE_SENT to SW.
   * SW tracks cumulative count and fires scoring at threshold (FR-03).
   */
  function observeAIChatMessages() {
    console.log('[PeerBridge:Content] observeAIChatMessages — starting observer');

    var observer = new MutationObserver(function () {
      clearTimeout(aiDebounceTimer);
      aiDebounceTimer = setTimeout(function () {
        if (chatCardShownThisSession) return;

        var host     = location.hostname;
        var selector = AI_CHAT_SELECTORS[host];
        if (!selector) return;

        var currentCount = document.querySelectorAll(selector).length;

        if (currentCount <= lastObservedMessageCount) return;

        lastObservedMessageCount = currentCount;
        console.log('[PeerBridge:Content] New AI message detected — count:', currentCount);

        var context = extractAIChatContext();

        sendToBackground(MESSAGES.AI_MESSAGE_SENT, {
          pageType:         CONFIG.PAGE_TYPE.AI_CHAT,
          messageCount:     context.messageCount,
          recentMessages:   context.recentMessages,
          sessionDurationMs: context.sessionDurationMs
        }, function (response) {
          if (response && response.show) {
            chatCardShownThisSession = true;
            maybeShowCard(response);
          }
        });

      }, 500); // Debounce 500ms — AI chat DOM updates frequently
    });

    // Observe body subtree for new message elements
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[PeerBridge:Content] MutationObserver active on document.body');
  }

  // =============================================================================
  // SW → CONTENT SCRIPT LISTENER (FR-23)
  // SW can remove the card immediately (e.g. pause from another tab).
  // =============================================================================

  chrome.runtime.onMessage.addListener(function (message) {
    console.log('[PeerBridge:Content] Message from SW:', message.type);

    if (message.type === MESSAGES.REMOVE_CARD) {
      console.log('[PeerBridge:Content] SW requested card removal — reason:', message.payload && message.payload.reason);

      if (activeCard) {
        activeCard.removeImmediately();
        activeCard = null;
      } else {
        // Fallback: remove by ID if activeCard reference is lost
        var host = document.getElementById('pb-card-host');
        if (host) host.remove();
      }

      cardInjected = false;
    }
  });

  // =============================================================================
  // INIT — detect page type and start appropriate handler
  // =============================================================================

  var pageType = detectPageType();

  if (pageType === CONFIG.PAGE_TYPE.SEARCH) {
    handleSearchPage();

  } else if (pageType === CONFIG.PAGE_TYPE.AI_CHAT) {
    observeAIChatMessages();

  } else {
    console.log('[PeerBridge:Content] Not a target page — content script idle');
  }

})();
