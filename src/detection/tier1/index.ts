import type { ExtractedText } from '../../types/proxy.js';
import type { PatternMatch } from '../../types/verdict.js';
import { normalize, decodeEncodings } from './normalizer.js';
import { PatternRegistry } from './patterns/index.js';

export class Tier1Engine {
  private registry: PatternRegistry;

  constructor(registry?: PatternRegistry) {
    this.registry = registry ?? new PatternRegistry();
  }

  scan(texts: ExtractedText[]): PatternMatch[] {
    const allMatches: PatternMatch[] = [];

    for (const text of texts) {
      const matches = this.scanText(text);
      allMatches.push(...matches);
    }

    return this.deduplicate(allMatches);
  }

  private scanText(extracted: ExtractedText): PatternMatch[] {
    const matches: PatternMatch[] = [];
    const { text: normalizedText } = normalize(extracted.text);

    // Run all patterns against normalized text
    this.runPatterns(normalizedText, matches);

    // Attempt to decode encodings and scan decoded variants
    const decoded = decodeEncodings(extracted.text);
    for (const dec of decoded) {
      if (dec.encoding === 'none') continue;
      const decodedMatches: PatternMatch[] = [];
      this.runPatterns(dec.decoded, decodedMatches);

      // Boost confidence for matches found in encoded content
      for (const m of decodedMatches) {
        m.confidence = Math.min(1.0, m.confidence + 0.15);
        m.offset = dec.originalOffset;
        m.length = dec.originalLength;
        m.description = `[${dec.encoding} decoded] ${m.description}`;
      }
      matches.push(...decodedMatches);
    }

    return matches;
  }

  private runPatterns(text: string, matches: PatternMatch[]): void {
    for (const compiled of this.registry.getPatterns()) {
      // Reset regex state for global patterns
      compiled.regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = compiled.regex.exec(text)) !== null) {
        matches.push({
          patternId: compiled.definition.id,
          description: compiled.definition.description,
          tier: 1,
          category: compiled.definition.category,
          confidence: compiled.definition.baseConfidence,
          weight: compiled.definition.weight,
          matchedText: match[0],
          offset: match.index,
          length: match[0].length,
        });

        // Prevent infinite loops on zero-length matches
        if (match[0].length === 0) {
          compiled.regex.lastIndex++;
        }

        // For non-global patterns, break after first match
        if (!compiled.regex.global) break;
      }
    }
  }

  private deduplicate(matches: PatternMatch[]): PatternMatch[] {
    const seen = new Set<string>();
    return matches.filter((m) => {
      const key = `${m.patternId}:${m.offset}:${m.length}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  get patternCount(): number {
    return this.registry.size;
  }
}
