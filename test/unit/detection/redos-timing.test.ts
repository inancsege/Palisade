import { describe, it, expect } from 'vitest';
import { PatternRegistry } from '../../../src/detection/tier1/patterns/index.js';

/**
 * Runtime ReDoS timing tests for all Tier 1 patterns.
 *
 * Complements the static analysis in redos-safety.test.ts by providing runtime
 * proof of safety. Each pattern is tested against adversarial input at 10K+
 * characters and must complete within 50ms. The 35 patterns that static analysis
 * could not definitively prove safe receive pattern-specific aggressive adversarial
 * strings designed to trigger worst-case backtracking.
 */
describe('ReDoS runtime timing', () => {
  const registry = new PatternRegistry();
  const patterns = registry.getPatterns();
  const TIMING_THRESHOLD_MS = 50;
  const BASE_LENGTH = 10_000;

  // Verify pattern count has not regressed
  it('should test at least 40 patterns', () => {
    expect(patterns.length).toBeGreaterThanOrEqual(40);
  });

  // Patterns proven safe by static analysis -- generic stress test is sufficient
  const STATICALLY_SAFE = new Set([
    'role-marker:inst-tags',
    'role-marker:im-start',
    'delimiter:xml-cdata-injection',
    'encoded:base64-suspicious',
    'encoded:url-encoded-tags',
    'encoded:url-ignore-instructions',
    'encoded:hex-escape',
    'encoded:unicode-fullwidth-system',
    'encoded:cyrillic-lookalike',
    'encoded:mixed-script-suspicious',
  ]);

  /**
   * Crafts pattern-specific adversarial input designed to maximize backtracking.
   *
   * For the 35 inconclusive patterns: matches the initial keyword, adds heavy
   * whitespace padding (10K spaces), then ends with a near-miss character that
   * forces the regex engine to backtrack through all alternation branches.
   *
   * For the 10 statically safe patterns: uses a generic 10K non-matching string
   * since these patterns are already proven safe via static analysis.
   */
  function craftAdversarialInput(id: string, regexStr: string): string {
    if (STATICALLY_SAFE.has(id)) {
      return 'x'.repeat(BASE_LENGTH);
    }

    // Pattern-specific adversarial inputs for the 35 inconclusive patterns
    const adversarialMap: Record<string, string> = {
      // Role markers (6 inconclusive)
      'role-marker:system-colon': '\n' + ' '.repeat(BASE_LENGTH) + 'SYSTEMx',
      'role-marker:sys-tags': '<<' + ' '.repeat(BASE_LENGTH) + 'SYx',
      'role-marker:anthropic-turn': '\n' + ' '.repeat(BASE_LENGTH) + 'Humanx',
      'role-marker:openai-role': '\n' + ' '.repeat(BASE_LENGTH) + 'systemx',
      'role-marker:xml-role-tags': '<system' + ' '.repeat(BASE_LENGTH),
      'role-marker:end-of-prompt': 'END' + ' '.repeat(BASE_LENGTH) + 'OF',

      // Delimiter escapes (6 inconclusive)
      'delimiter:triple-backtick-break': '```' + ' '.repeat(BASE_LENGTH) + 'systemx',
      'delimiter:horizontal-rule-separator':
        '\n---\n' + ' '.repeat(BASE_LENGTH) + 'ignorex',
      'delimiter:html-comment-injection': '<!--' + ' '.repeat(BASE_LENGTH) + 'systemx',
      'delimiter:json-injection': '"role"' + ' '.repeat(BASE_LENGTH) + ':x',
      'delimiter:markdown-heading-system': '\n# System' + ' '.repeat(BASE_LENGTH) + 'x',
      'delimiter:context-boundary': '\n===' + ' '.repeat(BASE_LENGTH) + 'CONTEXTx',

      // Override phrases (all 13 inconclusive)
      'override:ignore-previous': 'ignore' + ' '.repeat(BASE_LENGTH) + 'previousx',
      'override:disregard': 'disregard' + ' '.repeat(BASE_LENGTH) + 'allx',
      'override:forget-everything': 'forget' + ' '.repeat(BASE_LENGTH) + 'everythingx',
      'override:new-instructions': 'new' + ' '.repeat(BASE_LENGTH) + 'instructionsx',
      'override:you-are-now': 'you' + ' '.repeat(BASE_LENGTH) + 'arex',
      'override:do-not-follow': 'do' + ' '.repeat(BASE_LENGTH) + 'notx',
      'override:act-as': 'act' + ' '.repeat(BASE_LENGTH) + 'asx',
      'override:developer-mode': 'enter' + ' '.repeat(BASE_LENGTH) + 'developerx',
      'override:jailbreak-dan': 'you' + ' '.repeat(BASE_LENGTH) + 'arex',
      'override:opposite-day': 'opposite' + ' '.repeat(BASE_LENGTH) + 'dayx',
      'override:from-now-on': 'from' + ' '.repeat(BASE_LENGTH) + 'nowx',
      'override:real-instructions': 'real' + ' '.repeat(BASE_LENGTH) + 'instructionsx',
      'override:important-override': 'IMPORTANT' + ' '.repeat(BASE_LENGTH) + 'ignorex',

      // Encoded payloads (1 inconclusive)
      'encoded:rot13-trigger': 'decode' + ' '.repeat(BASE_LENGTH) + 'thisx',

      // Exfiltration (9 inconclusive)
      'exfil:output-system-prompt': 'output' + ' '.repeat(BASE_LENGTH) + 'systemx',
      'exfil:repeat-everything-above': 'repeat' + ' '.repeat(BASE_LENGTH) + 'everythingx',
      'exfil:curl-wget-in-prompt': 'curl' + ' '.repeat(BASE_LENGTH) + 'httpx',
      'exfil:url-with-data-param':
        'https://evil.com/' + 'a'.repeat(BASE_LENGTH) + '?datax=',
      'exfil:markdown-image-exfil':
        '![](' + 'https://evil.com/' + 'a'.repeat(BASE_LENGTH) + '{{',
      'exfil:send-to-webhook': 'send' + ' '.repeat(BASE_LENGTH) + 'datax',
      'exfil:env-var-access': 'print' + ' '.repeat(BASE_LENGTH) + 'environmentx',
      'exfil:file-read-sensitive': 'read' + ' '.repeat(BASE_LENGTH) + 'filex',
      'exfil:what-are-your-instructions': 'what' + ' '.repeat(BASE_LENGTH) + 'arex',
    };

    return adversarialMap[id] ?? 'x'.repeat(BASE_LENGTH);
  }

  // Build test data for parameterized testing
  const testCases = patterns.map((p) => {
    const input = craftAdversarialInput(p.definition.id, p.definition.regex);
    return {
      id: p.definition.id,
      regex: p.definition.regex,
      flags: p.definition.flags ?? 'gi',
      len: input.length,
      input,
    };
  });

  it.each(testCases)(
    'pattern $id completes within ' + TIMING_THRESHOLD_MS + 'ms on adversarial input ($len chars)',
    ({ id, regex, flags, input }) => {
      // Create a fresh RegExp to avoid lastIndex contamination from prior tests
      const re = new RegExp(regex, flags);

      // Warmup: ensure JIT compilation before timed run
      re.lastIndex = 0;
      re.exec(input.slice(0, 100));

      // Timed run against full adversarial input
      const start = performance.now();
      re.lastIndex = 0;
      re.exec(input);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(TIMING_THRESHOLD_MS);
    },
  );
});
