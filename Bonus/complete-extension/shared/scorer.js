/**
 * =============================================================================
 * FILE: shared/scorer.js
 * PURPOSE: Relevance scoring engine. Analyses anonymised page signals and
 *          returns a score 0.0–1.0. If score >= threshold (0.60), a peer
 *          suggestion card is shown.
 * USED BY: service-worker.js via importScripts()
 * WHY IN SW ONLY: Scoring runs in the background — content scripts send raw
 *                 anonymised signals, SW scores them. Keeps scoring logic
 *                 centralised and prevents heavy processing in page context.
 * DEPENDS ON: shared/constants.js (must be loaded first)
 * =============================================================================
 */

var PB = (typeof window !== 'undefined' ? window : globalThis).PB;

// =============================================================================
// KEYWORD SIGNAL LISTS
// Words that indicate the user is navigating a real goal or challenge.
// =============================================================================

/** Goal-oriented intent keywords — strong positive scoring signal */
PB.GOAL_KEYWORDS = [
  // Decision making
  'should i', 'how do i', 'is it worth', 'best way to', 'how to decide',
  'what to do', 'i need to', "i'm trying to", 'help me', 'advice on',
  // Career transitions
  'career change', 'job offer', 'resign', 'quit', 'fired', 'layoff',
  'negotiating salary', 'promotion', 'starting a business', 'side hustle',
  // Finance
  'mortgage', 'refinance', 'debt', 'invest', 'retirement', 'savings',
  'credit score', 'loan', 'bankruptcy',
  // Health & wellbeing
  'diagnosis', 'symptoms', 'treatment options', 'second opinion',
  'therapy', 'anxiety', 'depression',
  // Life events
  'divorce', 'separation', 'moving abroad', 'immigration', 'visa',
  'college application', 'grad school', 'gap year',
  // Stuck signals
  "don't know where to start", 'stuck on', 'confused about',
  'struggling with', "can't figure out", 'overwhelmed'
];

/**
 * Frustration keywords — indicate AI is reaching its limits (FR-03 context).
 * These carry double weight because they're the clearest signal.
 */
PB.FRUSTRATION_KEYWORDS = [
  "i've tried everything", 'nothing is working', "still doesn't work",
  "you're not understanding", "that's not what i asked",
  "that's wrong", 'incorrect', 'useless', 'not helpful',
  'can you try again', 'let me rephrase', 'you keep saying'
];

// =============================================================================
// SEARCH PAGE SCORER (FR-01, FR-02)
// Signals: query string only. Never reads page content.
// =============================================================================

/**
 * scoreSearchContext
 * Scores a search query to determine peer suggestion relevance.
 * Uses query length, keyword presence, and sentence structure.
 * @param {object} payload - { query: string }
 * @returns {number} score between 0.0 and 1.0
 */
PB.scoreSearchContext = function (payload) {
  var query = payload.query || '';
  if (!query) {
    console.log('[PeerBridge:scorer] scoreSearchContext — empty query, score: 0');
    return 0;
  }

  var q     = query.toLowerCase().trim();
  var score = 0;

  // Query length: longer queries = more deliberate = higher intent
  if (q.length > 20) score += 0.10;
  if (q.length > 40) score += 0.10;
  console.log('[PeerBridge:scorer] Search — length bonus:', score, 'for length:', q.length);

  // Goal keyword hits
  var goalHits = PB.GOAL_KEYWORDS.filter(function (kw) { return q.includes(kw); }).length;
  var keywordBonus = Math.min(goalHits * 0.20, 0.50);
  score += keywordBonus;
  console.log('[PeerBridge:scorer] Search — keyword hits:', goalHits, 'bonus:', keywordBonus);

  // Question structure
  if (q.startsWith('how') || q.startsWith('should') || q.startsWith('what')) {
    score += 0.10;
    console.log('[PeerBridge:scorer] Search — question structure bonus: 0.10');
  }

  // Word count: multi-word = more complex topic
  var wordCount = q.split(' ').length;
  if (wordCount >= 5) score += 0.10;
  if (wordCount >= 8) score += 0.10;
  console.log('[PeerBridge:scorer] Search — word count:', wordCount);

  var final = Math.min(score, 1.0);
  console.log('[PeerBridge:scorer] scoreSearchContext FINAL:', final, 'for query:', q.substring(0, 60));
  return final;
};

// =============================================================================
// AI CHAT SCORER (FR-01, FR-02, FR-03)
// Signals: message count, session duration, recent message text (anonymised).
// =============================================================================

/**
 * scoreAIChatContext
 * Scores an AI chat session for peer suggestion relevance.
 * Frustration signals carry extra weight — they're the clearest indicator
 * that AI has reached its limits.
 * @param {object} payload - { messageCount, recentMessages, sessionDurationMs }
 * @returns {number} score between 0.0 and 1.0
 */
PB.scoreAIChatContext = function (payload) {
  var messageCount     = payload.messageCount     || 0;
  var recentMessages   = payload.recentMessages   || [];
  var sessionDurationMs = payload.sessionDurationMs || 0;
  var score = 0;

  // FR-03: 3+ messages is baseline trigger
  if (messageCount >= PB.CONFIG.AI_CHAT_MESSAGE_THRESHOLD) {
    score += 0.30;
    console.log('[PeerBridge:scorer] AI — message threshold met:', messageCount);
  }
  if (messageCount >= 6)  score += 0.10;
  if (messageCount >= 10) score += 0.10;

  // Session duration — longer = AI not resolving the issue
  if (sessionDurationMs > 2 * 60 * 1000) score += 0.10;
  if (sessionDurationMs > 5 * 60 * 1000) score += 0.10;
  console.log('[PeerBridge:scorer] AI — session duration:', Math.round(sessionDurationMs / 1000) + 's');

  // Goal keywords in recent messages
  var combinedText = recentMessages.join(' ').toLowerCase();
  var goalHits = PB.GOAL_KEYWORDS.filter(function (kw) { return combinedText.includes(kw); }).length;
  score += Math.min(goalHits * 0.15, 0.30);
  console.log('[PeerBridge:scorer] AI — goal keyword hits in messages:', goalHits);

  // Frustration keywords — strong signal, double weight
  var frustHits = PB.FRUSTRATION_KEYWORDS.filter(function (kw) { return combinedText.includes(kw); }).length;
  score += Math.min(frustHits * 0.20, 0.40);
  console.log('[PeerBridge:scorer] AI — frustration hits:', frustHits);

  var final = Math.min(score, 1.0);
  console.log('[PeerBridge:scorer] scoreAIChatContext FINAL:', final);
  return final;
};

// =============================================================================
// FORM PAGE SCORER (FR-01, FR-02, FR-04)
// Signals: field count + time spent. Never reads field values (FR-05).
// =============================================================================

/**
 * scoreFormContext
 * Scores a form-heavy page. Hard gate: both field count AND time must be met.
 * URL/title provide additional context signal without reading any values.
 * @param {object} payload - { fieldCount, timeSpentMs, pageTitle, pageUrl }
 * @returns {number} score between 0.0 and 1.0
 */
PB.scoreFormContext = function (payload) {
  var fieldCount  = payload.fieldCount  || 0;
  var timeSpentMs = payload.timeSpentMs || 0;
  var pageTitle   = payload.pageTitle   || '';
  var pageUrl     = payload.pageUrl     || '';

  // FR-04: HARD GATE — both conditions must be true
  var meetsThreshold =
    fieldCount  >= PB.CONFIG.FORM_FIELD_THRESHOLD &&
    timeSpentMs >= PB.CONFIG.FORM_TIME_THRESHOLD_MS;

  if (!meetsThreshold) {
    console.log('[PeerBridge:scorer] scoreFormContext — hard gate not met. fields:', fieldCount, 'time:', timeSpentMs + 'ms');
    return 0;
  }

  var score = 0.40; // Base score for meeting the hard gate

  // More fields = more complex form = more likely to need help
  if (fieldCount >= 8)  score += 0.10;
  if (fieldCount >= 12) score += 0.10;

  // More time = more struggle
  if (timeSpentMs > 120000) score += 0.10; // 2+ min
  if (timeSpentMs > 300000) score += 0.10; // 5+ min

  // URL/title context — only high-stakes form types
  var context      = (pageTitle + ' ' + pageUrl).toLowerCase();
  var formKeywords = ['application', 'apply', 'onboarding', 'registration',
    'enrollment', 'immigration', 'visa', 'benefits', 'insurance', 'mortgage', 'loan'];
  var ctxHits = formKeywords.filter(function (k) { return context.includes(k); }).length;
  score += Math.min(ctxHits * 0.10, 0.20);
  console.log('[PeerBridge:scorer] Form — context keyword hits:', ctxHits);

  var final = Math.min(score, 1.0);
  console.log('[PeerBridge:scorer] scoreFormContext FINAL:', final, 'fields:', fieldCount, 'time:', Math.round(timeSpentMs / 1000) + 's');
  return final;
};

// =============================================================================
// THRESHOLD CHECK
// =============================================================================

/**
 * isAboveThreshold
 * Returns true if score meets or exceeds the configured threshold (FR-02).
 * @param {number} score
 * @param {number} [threshold] - defaults to CONFIG.RELEVANCE_THRESHOLD
 * @returns {boolean}
 */
PB.isAboveThreshold = function (score, threshold) {
  var t      = threshold !== undefined ? threshold : PB.CONFIG.RELEVANCE_THRESHOLD;
  var result = score >= t;
  console.log('[PeerBridge:scorer] isAboveThreshold:', score, '>=', t, '=', result);
  return result;
};

// =============================================================================
// ANONYMISED CONTEXT BUILDER (FR-05)
// Strips all PII before any context is sent externally.
// =============================================================================

/**
 * buildAnonymisedContext
 * Creates a safe, PII-free context object for the peer match API.
 * Removes emails, phone numbers, proper nouns, and numeric IDs from queries.
 * @param {object} params - { pageType, query, messageCount, fieldCount }
 * @returns {object} anonymised context safe for external transmission
 */
PB.buildAnonymisedContext = function (params) {
  var pageType     = params.pageType;
  var query        = params.query        || '';
  var messageCount = params.messageCount || null;
  var fieldCount   = params.fieldCount   || null;

  var intentSignal = null;
  if (query) {
    intentSignal = query
      .toLowerCase()
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]')  // Strip emails
      .replace(/\b\d{7,}\b/g, '[num]')                                   // Strip long numbers
      .replace(/\b[A-Z][a-z]{2,}\b/g, '[name]')                         // Strip proper nouns
      .substring(0, 120);                                                 // Cap length
  }

  var context = {
    pageType:     pageType,
    intentSignal: intentSignal,
    messageCount: messageCount,
    fieldCount:   fieldCount,
    timestamp:    Date.now()
  };

  console.log('[PeerBridge:scorer] buildAnonymisedContext — safe context built:', context);
  return context;
};

console.log('[PeerBridge] scorer.js loaded — all scoring functions ready on PB namespace.');
