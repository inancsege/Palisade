import type { PatternCategory } from '../../../types/verdict.js';
import type { CompiledPattern, PatternDefinition } from '../../../types/detection.js';
import { roleMarkerPatterns } from './role-markers.js';
import { delimiterEscapePatterns } from './delimiter-escapes.js';
import { overridePhrasePatterns } from './override-phrases.js';
import { encodedPayloadPatterns } from './encoded-payloads.js';
import { exfiltrationPatterns } from './exfiltration.js';

const BUILTIN_PATTERNS: PatternDefinition[] = [
  ...roleMarkerPatterns,
  ...delimiterEscapePatterns,
  ...overridePhrasePatterns,
  ...encodedPayloadPatterns,
  ...exfiltrationPatterns,
];

export class PatternRegistry {
  private patterns: CompiledPattern[] = [];

  constructor() {
    this.loadPatterns(BUILTIN_PATTERNS);
  }

  private loadPatterns(definitions: PatternDefinition[]): void {
    for (const def of definitions) {
      if (def.enabled === false) continue;
      this.patterns.push(this.compile(def));
    }
  }

  addPattern(definition: PatternDefinition): void {
    this.patterns.push(this.compile(definition));
  }

  getPatterns(category?: PatternCategory): CompiledPattern[] {
    if (!category) return this.patterns;
    return this.patterns.filter((p) => p.definition.category === category);
  }

  get size(): number {
    return this.patterns.length;
  }

  private compile(definition: PatternDefinition): CompiledPattern {
    const flags = definition.flags ?? 'gi';
    return {
      definition,
      // eslint-disable-next-line security/detect-non-literal-regexp -- regex strings come from trusted builtin pattern definitions, not user input
      regex: new RegExp(definition.regex, flags),
    };
  }
}
