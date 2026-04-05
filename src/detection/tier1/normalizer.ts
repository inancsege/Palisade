export interface NormalizedInput {
  text: string;
  original: string;
}

export interface DecodedInput {
  encoding: 'base64' | 'url' | 'unicode_escape' | 'html_entity' | 'rot13' | 'leet' | 'none';
  decoded: string;
  originalOffset: number;
  originalLength: number;
}

// Zero-width and invisible format characters to strip (per D-01)
// Includes: ZWSP, ZWNJ, ZWJ, BOM, soft hyphen, word joiner, Mongolian vowel separator,
//           bidi controls (LRM, RLM, LRE, RLE, PDF, LRO, RLO), bidi isolates (LRI, RLI, FSI, PDI),
//           variation selectors (VS1-VS16)
/* eslint-disable no-misleading-character-class -- intentional invisible character class for security stripping */
const ZERO_WIDTH_RE =
  /[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E\u200E\u200F\u202A-\u202E\u2066-\u2069\uFE00-\uFE0F]/g;
/* eslint-enable no-misleading-character-class */

const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic lowercase -> Latin
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043E': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u04BB': 'h',
  '\u0456': 'i',
  '\u0458': 'j',
  '\u0455': 's',
  // Cyrillic uppercase -> Latin
  '\u0410': 'A',
  '\u0412': 'B',
  '\u0415': 'E',
  '\u041A': 'K',
  '\u041C': 'M',
  '\u041D': 'H',
  '\u041E': 'O',
  '\u0420': 'P',
  '\u0421': 'C',
  '\u0422': 'T',
  '\u0425': 'X',
  '\u0405': 'S',
  '\u0408': 'J',
  '\u0406': 'I',
  // Greek lowercase -> Latin
  '\u03BF': 'o',
  '\u03BD': 'v',
  '\u03BA': 'k',
  '\u03C5': 'u',
  // Greek uppercase -> Latin
  '\u0391': 'A',
  '\u0392': 'B',
  '\u0395': 'E',
  '\u0396': 'Z',
  '\u0397': 'H',
  '\u0399': 'I',
  '\u039A': 'K',
  '\u039C': 'M',
  '\u039D': 'N',
  '\u039F': 'O',
  '\u03A1': 'P',
  '\u03A4': 'T',
  '\u03A5': 'Y',
  '\u03A7': 'X',
};

const HOMOGLYPH_RE = new RegExp('[' + Object.keys(HOMOGLYPH_MAP).join('') + ']', 'g');

function stripMarkdown(text: string): string {
  // Order matters: more specific patterns before general ones

  // 1. Code block fences -- line-anchored for ReDoS safety (no [\s\S]*? backtracking)
  text = text.replace(/^```[^\n]*$/gm, '');

  // 2. Inline code backticks
  text = text.replace(/`([^`]+)`/g, '$1');

  // 3. Images ![alt](url) -- before links to avoid overlap
  // eslint-disable-next-line redos/no-vulnerable -- negated character classes [^\]]* and [^)]* are linear; no nested quantifiers
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 4. Links [text](url)
  // eslint-disable-next-line redos/no-vulnerable -- negated character classes [^\]]* and [^)]* are linear; no nested quantifiers
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 5. Bold/italic (** and __ before * and _ to handle correctly)
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');

  // 6. Headers (# to ######)
  text = text.replace(/^#{1,6}\s+/gm, '');

  return text;
}

const HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&#x27;': "'",
  '&#x2F;': '/',
  '&#47;': '/',
};

const HTML_ENTITY_RE = /&(?:lt|gt|amp|quot|apos|#39|#x27|#x2F|#47);/gi;

export function normalize(input: string): NormalizedInput {
  // 1. Unicode NFKC normalization (collapses fullwidth chars, compatibility forms)
  let text = input.normalize('NFKC');

  // 2. Strip zero-width and invisible format characters (D-01)
  text = text.replace(ZERO_WIDTH_RE, '');

  // 3. Normalize Cyrillic/Greek homoglyphs to Latin (D-06, D-04: runs after NFKC)
  text = text.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPH_MAP[ch] ?? ch);

  // 4. Strip markdown formatting (D-05, D-09, D-10)
  text = stripMarkdown(text);

  // 5. Decode HTML entities
  text = text.replace(HTML_ENTITY_RE, (match) => HTML_ENTITIES[match.toLowerCase()] ?? match);

  // 6. Collapse consecutive whitespace to single space (preserve newlines)
  text = text.replace(/[^\S\n]+/g, ' ');

  // 7. Trim
  text = text.trim();

  return { text, original: input };
}

// eslint-disable-next-line security/detect-unsafe-regex -- nested quantifiers are fixed-count; linear time
const BASE64_RE = /(?:[A-Za-z0-9+/]{4}){5,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;
// eslint-disable-next-line security/detect-unsafe-regex -- [^%]* cannot match group delimiter %; linear time
const URL_ENCODED_RE = /(?:%[0-9A-Fa-f]{2}[^%]*){3,}/g;
// eslint-disable-next-line security/detect-unsafe-regex -- all fixed-length quantifiers; linear time
const UNICODE_ESCAPE_RE = /(?:\\u[0-9A-Fa-f]{4}){2,}/g;

export function decodeEncodings(input: string): DecodedInput[] {
  const results: DecodedInput[] = [];

  // Base64 detection
  for (const match of input.matchAll(BASE64_RE)) {
    try {
      const decoded = Buffer.from(match[0], 'base64').toString('utf-8');
      // Only keep if decoded text is mostly printable ASCII
      if (decoded.length > 3 && /^[\x20-\x7E\n\r\t]+$/.test(decoded)) {
        results.push({
          encoding: 'base64',
          decoded,
          originalOffset: match.index,
          originalLength: match[0].length,
        });
      }
    } catch {
      // Not valid base64, skip
    }
  }

  // URL encoding detection
  for (const match of input.matchAll(URL_ENCODED_RE)) {
    try {
      const decoded = decodeURIComponent(match[0]);
      if (decoded !== match[0]) {
        results.push({
          encoding: 'url',
          decoded,
          originalOffset: match.index,
          originalLength: match[0].length,
        });
      }
    } catch {
      // Invalid encoding, skip
    }
  }

  // Unicode escape detection
  for (const match of input.matchAll(UNICODE_ESCAPE_RE)) {
    try {
      const decoded = match[0].replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
      if (decoded !== match[0]) {
        results.push({
          encoding: 'unicode_escape',
          decoded,
          originalOffset: match.index,
          originalLength: match[0].length,
        });
      }
    } catch {
      // Invalid encoding, skip
    }
  }

  return results;
}
