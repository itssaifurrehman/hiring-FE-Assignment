/**
 * =============================================================================
 * FILE: src/components/suggestion-card.js
 * PURPOSE: The peer suggestion overlay card UI component.
 *          Self-contained Shadow DOM component. Handles all card rendering,
 *          animations, countdown, keyboard navigation, and accessibility.
 * USED BY: content-main.js (creates instance when SW says show:true)
 *          card-prototype.html (standalone demo)
 * MV3 NOTE: Plain JS IIFE — no import/export. Attaches to window.PB.SuggestionCard.
 * FR COVERAGE: FR-06, FR-07, FR-08, FR-09, FR-10, FR-11, FR-12, FR-13, FR-21
 * =============================================================================
 */

(function () {
  'use strict';

  // =============================================================================
  // CARD STYLES
  // Scoped entirely within Shadow DOM — zero leakage to host page.
  // Uses CSS custom properties for theming (light/dark).
  // =============================================================================
  var CARD_STYLES = [
    /* ── Design Tokens — Light Mode ─────────────────────────────────── */
    ':host {',
    '  position: fixed;',
    '  bottom: 24px;',
    '  right: 24px;',
    '  z-index: 2147483647;',        /* Max possible z-index */
    '  width: 320px;',
    '  max-width: calc(100vw - 48px);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;',
    /* Light mode tokens */
    '  --pb-bg:             rgba(255,255,255,0.93);',
    '  --pb-border:         rgba(0,0,0,0.08);',
    '  --pb-shadow:         0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);',
    '  --pb-text-primary:   #0f0f10;',
    '  --pb-text-secondary: #5c5c6e;',
    '  --pb-text-muted:     #8b8b9e;',
    '  --pb-accent:         #4f46e5;',
    '  --pb-accent-hover:   #4338ca;',
    '  --pb-accent-text:    #ffffff;',
    '  --pb-surface:        rgba(0,0,0,0.05);',
    '  --pb-surface-hover:  rgba(0,0,0,0.09);',
    '  --pb-dismiss-text:   #3d3d4d;',
    '  --pb-pause-text:     #6b6b7e;',
    '  --pb-avatar-bg:      #eef2ff;',
    '  --pb-avatar-text:    #4f46e5;',
    '  --pb-online:         #16a34a;',
    '  --pb-soon:           #d97706;',
    '  --pb-today:          #2563eb;',
    '  --pb-progress-bg:    rgba(0,0,0,0.06);',
    '  --pb-progress-fill:  #4f46e5;',
    '  --pb-radius:         14px;',
    '  --pb-radius-sm:      8px;',
    '  --pb-radius-xs:      6px;',
    '}',

    /* ── Dark Mode Tokens (FR-11) ────────────────────────────────────── */
    /* Considered, not just inverted: different elevations, muted accents */
    '@media (prefers-color-scheme: dark) {',
    '  :host {',
    '    --pb-bg:             rgba(26,26,36,0.95);',
    '    --pb-border:         rgba(255,255,255,0.10);',
    '    --pb-shadow:         0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06);',
    '    --pb-text-primary:   #f0f0f5;',
    '    --pb-text-secondary: #a0a0b8;',
    '    --pb-text-muted:     #6e6e88;',
    '    --pb-accent:         #818cf8;',
    '    --pb-accent-hover:   #6366f1;',
    '    --pb-surface:        rgba(255,255,255,0.07);',
    '    --pb-surface-hover:  rgba(255,255,255,0.12);',
    '    --pb-dismiss-text:   #c0c0d8;',
    '    --pb-pause-text:     #8080a0;',
    '    --pb-avatar-bg:      rgba(129,140,248,0.15);',
    '    --pb-avatar-text:    #818cf8;',
    '    --pb-online:         #4ade80;',
    '    --pb-soon:           #fbbf24;',
    '    --pb-today:          #60a5fa;',
    '    --pb-progress-bg:    rgba(255,255,255,0.08);',
    '    --pb-progress-fill:  #818cf8;',
    '  }',
    '}',

    /* ── Reset ───────────────────────────────────────────────────────── */
    '*,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }',

    /* ── Card Shell ──────────────────────────────────────────────────── */
    '.pb-card {',
    '  background: var(--pb-bg);',
    '  border: 1px solid var(--pb-border);',
    '  border-radius: var(--pb-radius);',
    '  box-shadow: var(--pb-shadow);',
    '  backdrop-filter: blur(20px) saturate(1.4);',
    '  -webkit-backdrop-filter: blur(20px) saturate(1.4);',
    '  overflow: hidden;',
    '  outline: none;',
    '  position: relative;',
    '  animation: pb-slide-in 0.28s cubic-bezier(0.34,1.56,0.64,1) forwards;',
    '}',
    '.pb-card:focus-visible { box-shadow: var(--pb-shadow), 0 0 0 3px var(--pb-accent); }',
    '.pb-card--out { animation: pb-slide-out 0.22s cubic-bezier(0.4,0,1,1) forwards !important; }',

    /* ── Branded left accent bar ─────────────────────────────────────── */
    '.pb-accent-bar {',
    '  position:absolute; top:0; left:0; width:3px; height:100%;',
    '  background: linear-gradient(180deg, var(--pb-accent), var(--pb-accent-hover));',
    '  border-radius: var(--pb-radius) 0 0 var(--pb-radius);',
    '}',

    /* ── Inner layout ────────────────────────────────────────────────── */
    '.pb-inner { padding: 14px 14px 14px 18px; display:flex; flex-direction:column; gap:12px; }',
    '.pb-header { display:flex; align-items:flex-start; gap:8px; }',

    /* ── Icon ────────────────────────────────────────────────────────── */
    '.pb-icon {',
    '  flex-shrink:0; width:28px; height:28px;',
    '  background:var(--pb-avatar-bg); color:var(--pb-accent);',
    '  border-radius:var(--pb-radius-xs);',
    '  display:flex; align-items:center; justify-content:center; margin-top:1px;',
    '}',

    /* ── Suggestion text ─────────────────────────────────────────────── */
    '.pb-suggestion {',
    '  flex:1; font-size:13px; font-weight:500; line-height:1.45;',
    '  color:var(--pb-text-primary); letter-spacing:-0.01em;',
    '}',

    /* ── Close button (X) ────────────────────────────────────────────── */
    '.pb-close {',
    '  flex-shrink:0; width:24px; height:24px;',
    '  border:none; background:transparent; color:var(--pb-text-muted);',
    '  cursor:pointer; border-radius:var(--pb-radius-xs);',
    '  display:flex; align-items:center; justify-content:center;',
    '  transition:background 0.15s,color 0.15s; margin-top:-2px; margin-right:-2px;',
    '}',
    '.pb-close:hover { background:var(--pb-surface); color:var(--pb-text-primary); }',
    '.pb-close:focus-visible { outline:2px solid var(--pb-accent); outline-offset:1px; }',

    /* ── Peer summary block ──────────────────────────────────────────── */
    '.pb-peer {',
    '  display:flex; align-items:center; gap:10px;',
    '  padding:9px 10px; background:var(--pb-surface); border-radius:var(--pb-radius-sm);',
    '}',
    '.pb-avatar {',
    '  flex-shrink:0; width:34px; height:34px;',
    '  background:var(--pb-avatar-bg); color:var(--pb-avatar-text);',
    '  border-radius:50%; display:flex; align-items:center; justify-content:center;',
    '  font-size:12px; font-weight:700; letter-spacing:0.02em;',
    '}',
    '.pb-peer-info { flex:1; min-width:0; }',
    '.pb-domain {',
    '  display:block; font-size:12.5px; font-weight:600; color:var(--pb-text-primary);',
    '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;',
    '}',
    '.pb-meta { display:flex; align-items:center; gap:5px; margin-top:2px; }',
    '.pb-exp { font-size:11.5px; color:var(--pb-text-secondary); font-weight:500; }',
    '.pb-sep { color:var(--pb-text-muted); font-size:11px; }',
    '.pb-avail { font-size:11.5px; font-weight:500; display:flex; align-items:center; gap:4px; }',
    '.pb-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }',
    '.pb-avail--online { color:var(--pb-online); }',
    '.pb-avail--online .pb-dot { background:var(--pb-online); }',
    '.pb-avail--soon { color:var(--pb-soon); }',
    '.pb-avail--soon .pb-dot { background:var(--pb-soon); }',
    '.pb-avail--today { color:var(--pb-today); }',
    '.pb-avail--today .pb-dot { background:var(--pb-today); }',

    /* ── Action buttons ──────────────────────────────────────────────── */
    '.pb-actions { display:flex; align-items:center; gap:6px; }',
    '.pb-btn {',
    '  border:none; cursor:pointer; font-family:inherit;',
    '  font-size:12.5px; font-weight:600; border-radius:var(--pb-radius-xs);',
    '  transition:background 0.15s,transform 0.1s,box-shadow 0.15s; white-space:nowrap;',
    '}',
    '.pb-btn:focus-visible { outline:2px solid var(--pb-accent); outline-offset:2px; }',
    '.pb-btn:active { transform:scale(0.97); }',

    /* Connect — primary action */
    '.pb-btn-connect {',
    '  padding:7px 14px; background:var(--pb-accent);',
    '  color:var(--pb-accent-text); flex-shrink:0; letter-spacing:-0.01em;',
    '}',
    '.pb-btn-connect:hover { background:var(--pb-accent-hover); box-shadow:0 2px 8px rgba(79,70,229,0.35); }',

    /* Not now — secondary action */
    '.pb-btn-dismiss {',
    '  padding:7px 12px; background:var(--pb-surface);',
    '  color:var(--pb-dismiss-text); flex-shrink:0;',
    '}',
    '.pb-btn-dismiss:hover { background:var(--pb-surface-hover); }',

    /* Pause today — tertiary, text-link style (FR-21) */
    '.pb-btn-pause {',
    '  padding:7px 0; background:transparent; color:var(--pb-pause-text);',
    '  margin-left:auto; font-weight:500; font-size:11.5px;',
    '  text-decoration:underline; text-underline-offset:2px;',
    '  text-decoration-color:transparent;',
    '  transition:text-decoration-color 0.15s,color 0.15s;',
    '}',
    '.pb-btn-pause:hover { color:var(--pb-text-secondary); text-decoration-color:var(--pb-text-muted); }',

    /* ── Auto-dismiss progress bar (FR-10) ───────────────────────────── */
    '.pb-progress { height:3px; background:var(--pb-progress-bg); position:relative; overflow:hidden; }',
    '.pb-progress-bar {',
    '  position:absolute; top:0; left:0; height:100%; width:100%;',
    '  background:var(--pb-progress-fill); transition:width 0.1s linear;',
    '  border-radius:0 2px 2px 0;',
    '}',

    /* ── Animations ──────────────────────────────────────────────────── */
    '@keyframes pb-slide-in {',
    '  from { opacity:0; transform:translateY(12px) scale(0.97); }',
    '  to   { opacity:1; transform:translateY(0)    scale(1); }',
    '}',
    '@keyframes pb-slide-out {',
    '  from { opacity:1; transform:translateY(0)   scale(1); }',
    '  to   { opacity:0; transform:translateY(8px) scale(0.96); }',
    '}',

    /* ── Screen reader only (aria-live announcements) ────────────────── */
    '.pb-sr-only {',
    '  position:absolute; width:1px; height:1px; padding:0;',
    '  margin:-1px; overflow:hidden; clip:rect(0,0,0,0);',
    '  white-space:nowrap; border:0;',
    '}',

    /* ── Reduced motion — respect user OS preference ─────────────────── */
    '@media (prefers-reduced-motion: reduce) {',
    '  .pb-card, .pb-card--out { animation:none !important; }',
    '  .pb-progress-bar { transition:none; }',
    '}'
  ].join('\n');

  // =============================================================================
  // SuggestionCard CLASS
  // =============================================================================

  /**
   * SuggestionCard
   * Constructor for the overlay card component.
   * @param {object} opts
   * @param {object}   opts.matchData      - peer match data from SW
   * @param {string}   opts.pageType       - 'search' | 'ai_chat' | 'form'
   * @param {boolean}  opts.autoDissmiss   - true = show 30s countdown (AI chat)
   * @param {function} opts.onConnect      - callback(matchId, contextToken)
   * @param {function} opts.onDismiss      - callback(reason)
   * @param {function} opts.onPauseForToday - callback()
   */
  function SuggestionCard(opts) {
    this._host          = null;  // The outer div appended to document.body
    this._shadow        = null;  // Shadow root (closed mode)
    this._rafId         = null;  // requestAnimationFrame ID for countdown
    this._countdownStart = null; // performance.now() when countdown began
    this._dismissed     = false; // Guard against double-dismiss

    this.opts = {
      matchData:       null,
      pageType:        'search',
      autoDissmiss:    false,
      onConnect:       null,
      onDismiss:       null,
      onPauseForToday: null
    };

    // Merge provided options
    for (var k in opts) {
      if (opts.hasOwnProperty(k)) this.opts[k] = opts[k];
    }

    console.log('[PeerBridge:Card] SuggestionCard created — pageType:', this.opts.pageType, '| autoDissmiss:', this.opts.autoDissmiss);
  }

  /**
   * mount
   * Injects the card into the page via Shadow DOM.
   * Called by content-main.js after receiving show:true from SW.
   * FR-06: Fixed bottom-right, does not block content.
   * FR-08: Must render within 1s — all HTML/CSS is bundled, no network needed.
   * FR-09: Shadow DOM closed mode prevents host page interference.
   */
  SuggestionCard.prototype.mount = function () {
    console.log('[PeerBridge:Card] mount — injecting card into page');

    // Prevent duplicate cards
    var existing = document.getElementById('pb-card-host');
    if (existing) {
      console.log('[PeerBridge:Card] Card already mounted — removing old one');
      existing.remove();
    }

    // Create host element
    this._host    = document.createElement('div');
    this._host.id = 'pb-card-host';

    // Attach Shadow DOM (closed mode — FR-09)
    this._shadow = this._host.attachShadow({ mode: 'closed' });

    // Inject styles
    var styleEl = document.createElement('style');
    styleEl.textContent = CARD_STYLES;
    this._shadow.appendChild(styleEl);

    // Build and inject card HTML
    var cardEl = this._buildCard();
    this._shadow.appendChild(cardEl);

    // Bind all event handlers
    this._bindEvents();

    // Append to page
    document.body.appendChild(this._host);

    // Move focus to card for accessibility (FR-12)
    var self = this;
    requestAnimationFrame(function () {
      var card = self._shadow.querySelector('.pb-card');
      if (card) card.focus();
    });

    // Start auto-dismiss countdown if AI chat page (FR-10)
    if (this.opts.autoDissmiss) {
      console.log('[PeerBridge:Card] Starting 30s auto-dismiss countdown (FR-10)');
      this._startCountdown();
    }

    console.log('[PeerBridge:Card] Card mounted successfully');
  };

  /**
   * _buildCard
   * Constructs the card DOM structure.
   * FR-07: Shows suggestion text, peer summary (domain, exp, availability), Connect, Not now.
   * FR-21: "Pause today" button is on the card itself (not just in settings).
   * @returns {HTMLElement}
   */
  SuggestionCard.prototype._buildCard = function () {
    var peer     = this.opts.matchData || {};
    var pageType = this.opts.pageType;

    // Suggestion text varies by page type
    var suggestionText;
    if (pageType === 'ai_chat') {
      // Verbatim from US-03 acceptance criteria
      suggestionText = 'AI can only go so far — connect with someone who has actually been here.';
    } else if (pageType === 'form') {
      suggestionText = 'Someone has navigated this process before. Want a real perspective?';
    } else {
      suggestionText = peer.suggestionPrompt || 'A real person who has been here wants to help.';
    }

    // Build peer initials for avatar
    var domain   = peer.domain || 'Peer Expert';
    var words    = domain.split(' ');
    var initials = ((words[0] || ' ')[0] + ((words[1] || ' ')[0])).toUpperCase();

    var yearsExp      = peer.yearsExperience || 5;
    var availability  = peer.availability    || 'Available';
    var availSignal   = peer.availabilitySignal || 'today';
    var autoDissmiss  = this.opts.autoDissmiss;

    // Build card element via innerHTML (safe — no user content injected directly)
    var card = document.createElement('div');
    card.innerHTML = [
      '<div class="pb-card"',
      '  role="dialog"',
      '  aria-label="Peer connection suggestion"',
      '  aria-describedby="pb-suggestion-text"',
      '  tabindex="-1"',
      '>',
      '  <div class="pb-accent-bar" aria-hidden="true"></div>',

      '  <div class="pb-inner">',

      '    <div class="pb-header">',
      '      <div class="pb-icon" aria-hidden="true">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
      '          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>',
      '          <circle cx="9" cy="7" r="4"/>',
      '          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
      '          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      '        </svg>',
      '      </div>',
      '      <p class="pb-suggestion" id="pb-suggestion-text">' + suggestionText + '</p>',
      '      <button class="pb-close" aria-label="Dismiss suggestion" data-action="dismiss">',
      '        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">',
      '          <line x1="18" y1="6" x2="6" y2="18"/>',
      '          <line x1="6" y1="6" x2="18" y2="18"/>',
      '        </svg>',
      '      </button>',
      '    </div>',

      '    <div class="pb-peer" aria-label="Matched peer profile">',
      '      <div class="pb-avatar" aria-hidden="true">' + initials + '</div>',
      '      <div class="pb-peer-info">',
      '        <span class="pb-domain">' + domain + '</span>',
      '        <div class="pb-meta">',
      '          <span class="pb-exp">' + yearsExp + 'y exp</span>',
      '          <span class="pb-sep" aria-hidden="true">·</span>',
      '          <span class="pb-avail pb-avail--' + availSignal + '" role="status">',
      '            <span class="pb-dot" aria-hidden="true"></span>',
      '            ' + availability,
      '          </span>',
      '        </div>',
      '      </div>',
      '    </div>',

      '    <div class="pb-actions">',
      '      <button class="pb-btn pb-btn-connect" data-action="connect" aria-label="Connect with this peer">Connect</button>',
      '      <button class="pb-btn pb-btn-dismiss" data-action="dismiss" aria-label="Not now, dismiss this suggestion">Not now</button>',
      '      <button class="pb-btn pb-btn-pause"   data-action="pause"   aria-label="Pause suggestions for today">Pause today</button>',
      '    </div>',

      '  </div>',

      // Progress bar only on AI chat auto-dismiss cards (FR-10)
      autoDissmiss
        ? '  <div class="pb-progress" aria-hidden="true"><div class="pb-progress-bar" id="pb-progress-bar"></div></div>'
        : '',

      // Screen reader live region for countdown announcements
      autoDissmiss
        ? '  <span class="pb-sr-only" aria-live="polite" id="pb-sr-announce"></span>'
        : '',

      '</div>'
    ].join('\n');

    return card.firstElementChild;
  };

  /**
   * _bindEvents
   * Attaches all event listeners to the shadow root.
   * Uses event delegation — one click listener handles all button actions.
   * Keyboard: Escape = dismiss, Tab = focus trap within card (FR-12).
   */
  SuggestionCard.prototype._bindEvents = function () {
    var self = this;

    // Delegated click handler
    this._shadow.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      var action = btn.dataset.action;
      console.log('[PeerBridge:Card] Button clicked:', action);

      if (action === 'connect') self._handleConnect();
      if (action === 'dismiss') self._handleDismiss();
      if (action === 'pause')   self._handlePause();
    });

    // Keyboard handler
    this._shadow.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        // FR-13: Escape = immediate dismiss
        e.preventDefault();
        console.log('[PeerBridge:Card] Escape key — dismissing');
        self._handleDismiss();
      }
      if (e.key === 'Tab') {
        self._handleTabTrap(e);
      }
    });

    console.log('[PeerBridge:Card] Events bound');
  };

  /**
   * _handleTabTrap
   * Keeps Tab focus cycling within the card (WCAG 2.1 dialog pattern — FR-12).
   * @param {KeyboardEvent} e
   */
  SuggestionCard.prototype._handleTabTrap = function (e) {
    var focusable = Array.prototype.slice.call(
      this._shadow.querySelectorAll('button')
    ).filter(function (b) { return !b.disabled; });

    if (!focusable.length) return;

    var first  = focusable[0];
    var last   = focusable[focusable.length - 1];
    var active = this._shadow.activeElement;

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  /**
   * _handleConnect
   * FR-24: Sends OPEN_TAB to SW with match_id and context_token in URL.
   * Logs to console as stub confirmation.
   */
  SuggestionCard.prototype._handleConnect = function () {
    var matchId      = (this.opts.matchData && this.opts.matchData.matchId)      || 'mock-001';
    var contextToken = (this.opts.matchData && this.opts.matchData.contextToken) || 'ctx-mock';

    console.log('[PeerBridge:Card] Connect clicked — match_id:', matchId, '| context_token:', contextToken);

    if (this.opts.onConnect) {
      this.opts.onConnect(matchId, contextToken);
    }

    this._dismiss('connect');
  };

  /**
   * _handleDismiss
   * FR-13: Immediate dismissal with no follow-up.
   */
  SuggestionCard.prototype._handleDismiss = function () {
    console.log('[PeerBridge:Card] Not now — dismissing immediately');
    this._dismiss('manual');
  };

  /**
   * _handlePause
   * FR-21: Pause suggestions for today, directly from the card.
   */
  SuggestionCard.prototype._handlePause = function () {
    console.log('[PeerBridge:Card] Pause for today clicked');
    if (this.opts.onPauseForToday) {
      this.opts.onPauseForToday();
    }
    this._dismiss('pause');
  };

  /**
   * _dismiss
   * Core dismiss logic. Plays exit animation then removes host from DOM.
   * Guards against double-dismiss with _dismissed flag.
   * @param {string} reason - 'manual' | 'auto' | 'connect' | 'pause' | 'external'
   */
  SuggestionCard.prototype._dismiss = function (reason) {
    if (this._dismissed) return;
    this._dismissed = true;

    console.log('[PeerBridge:Card] _dismiss — reason:', reason);

    // Stop countdown if running
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    var self = this;
    var card = this._shadow.querySelector('.pb-card');

    if (card) {
      // Play exit animation
      card.classList.add('pb-card--out');
      card.addEventListener('animationend', function () {
        if (self._host && self._host.parentNode) {
          self._host.remove();
        }
        if (self.opts.onDismiss) {
          self.opts.onDismiss(reason);
        }
      }, { once: true });
    } else {
      if (this._host && this._host.parentNode) {
        this._host.remove();
      }
      if (this.opts.onDismiss) {
        this.opts.onDismiss(reason);
      }
    }
  };

  /**
   * removeImmediately
   * Called externally (e.g. from chrome.runtime.onMessage) when SW says remove card.
   * No animation — instant removal.
   */
  SuggestionCard.prototype.removeImmediately = function () {
    console.log('[PeerBridge:Card] removeImmediately called');
    this._dismissed = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._host && this._host.parentNode) this._host.remove();
  };

  /**
   * _startCountdown
   * FR-10: 30-second auto-dismiss for AI chat pages.
   * Uses requestAnimationFrame for smooth progress bar animation.
   * Announces remaining time to screen readers at 10s and 5s via aria-live.
   */
  SuggestionCard.prototype._startCountdown = function () {
    var duration         = PB.CONFIG.AUTO_DISMISS_MS; // 30000ms
    this._countdownStart = performance.now();
    var lastAnnounced    = 30;
    var self             = this;

    function tick(now) {
      if (self._dismissed) return;

      var elapsed   = now - self._countdownStart;
      var remaining = Math.max(0, duration - elapsed);
      var pct       = (remaining / duration) * 100;

      // Update progress bar width
      var bar = self._shadow.querySelector('#pb-progress-bar');
      if (bar) bar.style.width = pct + '%';

      // Screen reader announcements at 10s and 5s remaining (FR-12)
      var secondsLeft = Math.ceil(remaining / 1000);
      var announce    = self._shadow.querySelector('#pb-sr-announce');
      if (announce && secondsLeft !== lastAnnounced) {
        if (secondsLeft === 10 || secondsLeft === 5) {
          announce.textContent = 'Peer suggestion dismissing in ' + secondsLeft + ' seconds';
          lastAnnounced = secondsLeft;
          console.log('[PeerBridge:Card] Countdown announcement:', secondsLeft + 's remaining');
        }
      }

      if (remaining <= 0) {
        console.log('[PeerBridge:Card] Auto-dismiss countdown complete');
        self._dismiss('auto');
        return;
      }

      self._rafId = requestAnimationFrame(tick);
    }

    this._rafId = requestAnimationFrame(tick);
    console.log('[PeerBridge:Card] Countdown started — duration:', duration / 1000 + 's');
  };

  // =============================================================================
  // EXPOSE TO WINDOW.PB NAMESPACE
  // =============================================================================
  var PB = (typeof window !== 'undefined' ? window : globalThis).PB || {};
  (typeof window !== 'undefined' ? window : globalThis).PB = PB;
  PB.SuggestionCard = SuggestionCard;

  console.log('[PeerBridge] suggestion-card.js loaded — PB.SuggestionCard ready.');

})();
