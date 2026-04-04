export interface NormalizedInput {
  text: string;
  original: string;
}

export interface DecodedInput {
  encoding: 'base64' | 'url' | 'unicode_escape' | 'html_entity' | 'rot13' | 'none';
  decoded: string;
  originalOffset: number;
  originalLength: number;
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
  // 1. Unicode NFKC normalization (collapses fullwidth chars, homoglyphs)
  let text = input.normalize('NFKC');

  // 2. Decode HTML entities
  text = text.replace(HTML_ENTITY_RE, (match) => HTML_ENTITIES[match.toLowerCase()] ?? match);

  // 3. Collapse consecutive whitespace to single space (preserve newlines)
  text = text.replace(/[^\S\n]+/g, ' ');

  // 4. Trim
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
