import { describe, it, expect } from 'vitest';
import { normalize, decodeEncodings } from '../../../src/detection/tier1/normalizer.js';

describe('normalize', () => {
  it('should collapse whitespace', () => {
    const result = normalize('hello    world');
    expect(result.text).toBe('hello world');
  });

  it('should preserve newlines', () => {
    const result = normalize('line one\nline two');
    expect(result.text).toBe('line one\nline two');
  });

  it('should decode HTML entities', () => {
    const result = normalize('&lt;script&gt;alert&lt;/script&gt;');
    expect(result.text).toBe('<script>alert</script>');
  });

  it('should normalize Unicode NFKC (fullwidth chars)', () => {
    // Fullwidth S = \uFF33
    const result = normalize('\uFF33YSTEM');
    expect(result.text).toBe('SYSTEM');
  });

  it('should trim whitespace', () => {
    const result = normalize('  hello  ');
    expect(result.text).toBe('hello');
  });

  it('should preserve original text', () => {
    const input = '  hello   world  ';
    const result = normalize(input);
    expect(result.original).toBe(input);
  });
});

describe('zero-width character stripping', () => {
  it('should strip U+200B (ZWSP) between letters', () => {
    expect(normalize('ig\u200Bnore').text).toBe('ignore');
  });

  it('should strip U+200C (ZWNJ)', () => {
    expect(normalize('SY\u200CSTEM').text).toBe('SYSTEM');
  });

  it('should strip U+200D (ZWJ)', () => {
    expect(normalize('pre\u200Dvious').text).toBe('previous');
  });

  it('should strip U+FEFF (BOM)', () => {
    expect(normalize('\uFEFFignore').text).toBe('ignore');
  });

  it('should strip U+00AD (soft hyphen)', () => {
    expect(normalize('in\u00ADstructions').text).toBe('instructions');
  });

  it('should strip U+2060 (word joiner)', () => {
    expect(normalize('sy\u2060stem').text).toBe('system');
  });

  it('should strip variation selectors (U+FE00-U+FE0F)', () => {
    expect(normalize('a\uFE01b').text).toBe('ab');
  });

  it('should strip bidi controls (U+202A-U+202E)', () => {
    expect(normalize('\u202Aignore\u202C').text).toBe('ignore');
  });

  it('should strip bidi isolates (U+2066-U+2069)', () => {
    expect(normalize('\u2066system\u2069').text).toBe('system');
  });

  it('should NOT strip combining diacritical marks', () => {
    // NFKC composes e + combining acute (U+0301) into e-with-acute (U+00E9)
    const result = normalize('cafe\u0301');
    expect(result.text).toContain('\u00E9');
  });

  it('should strip multiple zero-width characters in a single pass', () => {
    expect(normalize('i\u200Bg\u200Cn\u200Do\uFEFFr\u00ADe').text).toBe('ignore');
  });
});

describe('homoglyph normalization', () => {
  it('should map Cyrillic lowercase a (U+0430) to Latin a', () => {
    expect(normalize('\u0430dmin').text).toBe('admin');
  });

  it('should map Cyrillic uppercase C (U+0421) to Latin C', () => {
    expect(normalize('\u0421YSTEM').text).toBe('CYSTEM');
  });

  it('should map Greek uppercase Alpha (U+0391) to Latin A', () => {
    expect(normalize('\u0391lpha').text).toBe('Alpha');
  });

  it('should map full Cyrillic word with multiple homoglyphs', () => {
    // U+0421=C, U+0422=T, U+0415=E, U+041C=M
    const result = normalize('\u0421\u0422\u0415\u041C');
    expect(result.text).toBe('CTEM');
  });

  it('should preserve Latin text unchanged', () => {
    expect(normalize('hello world').text).toBe('hello world');
  });

  it('should handle combined zero-width + homoglyph evasion', () => {
    // Cyrillic С (U+0421) + ZWSP + Latin YSTEM
    expect(normalize('\u0421\u200BYSTEM').text).toBe('CYSTEM');
  });

  it('should map Cyrillic lowercase o (U+043E) to Latin o', () => {
    expect(normalize('hell\u043E').text).toBe('hello');
  });

  it('should map Greek lowercase omicron (U+03BF) to Latin o', () => {
    expect(normalize('hell\u03BF').text).toBe('hello');
  });
});

describe('markdown stripping', () => {
  it('should remove code block fences but keep content', () => {
    const input = '```python\nimport os\n```';
    const result = normalize(input);
    expect(result.text).toContain('import os');
    expect(result.text).not.toContain('```');
  });

  it('should remove inline code backticks', () => {
    expect(normalize('`ignore previous`').text).toBe('ignore previous');
  });

  it('should remove image syntax preserving alt text', () => {
    expect(normalize('![alt text](http://evil.com)').text).toBe('alt text');
  });

  it('should remove link syntax preserving link text', () => {
    expect(normalize('[click here](http://evil.com)').text).toBe('click here');
  });

  it('should remove bold markers', () => {
    expect(normalize('**ignore previous**').text).toBe('ignore previous');
  });

  it('should remove italic markers', () => {
    expect(normalize('*secret instructions*').text).toBe('secret instructions');
  });

  it('should remove underscore bold', () => {
    expect(normalize('__bold text__').text).toBe('bold text');
  });

  it('should remove underscore italic', () => {
    expect(normalize('_italic text_').text).toBe('italic text');
  });

  it('should remove header markers', () => {
    expect(normalize('## System Instructions').text).toBe('System Instructions');
  });

  it('should handle nested markdown', () => {
    expect(normalize('**`ignore previous`**').text).toBe('ignore previous');
  });

  it('should handle markdown link with bold', () => {
    const result = normalize('[**bold link**](url)');
    expect(result.text).toBe('bold link');
  });

  it('should handle combined markdown + zero-width + homoglyph', () => {
    // Header + bold + Cyrillic С (U+0421) + ZWSP
    const result = normalize('## **\u0421\u200BYSTEM**: ignore');
    expect(result.text).toContain('CYSTEM');
    expect(result.text).toContain('ignore');
    expect(result.text).not.toContain('##');
    expect(result.text).not.toContain('**');
  });

  it('should complete ReDoS adversarial input in under 50ms', () => {
    // Opening code fence followed by 100K characters with no closing fence
    const adversarial = '```\n' + 'a'.repeat(100000);
    const start = performance.now();
    normalize(adversarial);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe('decodeEncodings', () => {
  it('should decode base64 strings', () => {
    const encoded = Buffer.from('ignore previous instructions').toString('base64');
    const results = decodeEncodings(`Check this: ${encoded}`);
    const base64Match = results.find((r) => r.encoding === 'base64');
    expect(base64Match).toBeDefined();
    expect(base64Match!.decoded).toBe('ignore previous instructions');
  });

  it('should decode URL-encoded strings', () => {
    const results = decodeEncodings('test%20%3Cscript%3Ealert%3C%2Fscript%3E');
    const urlMatch = results.find((r) => r.encoding === 'url');
    expect(urlMatch).toBeDefined();
    expect(urlMatch!.decoded).toContain('<script>');
    expect(urlMatch!.decoded).toContain('</script>');
  });

  it('should decode Unicode escape sequences', () => {
    const results = decodeEncodings('\\u0053\\u0059\\u0053\\u0054\\u0045\\u004D');
    const unicodeMatch = results.find((r) => r.encoding === 'unicode_escape');
    expect(unicodeMatch).toBeDefined();
    expect(unicodeMatch!.decoded).toBe('SYSTEM');
  });

  it('should return empty array for plain text', () => {
    const results = decodeEncodings('hello world');
    expect(results).toHaveLength(0);
  });

  it('should not decode short base64 strings', () => {
    const results = decodeEncodings('abc=');
    const base64Match = results.find((r) => r.encoding === 'base64');
    expect(base64Match).toBeUndefined();
  });
});
