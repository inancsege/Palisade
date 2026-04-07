import { describe, it, expect } from 'vitest';
import { DetectionEngine } from '../../../src/detection/engine.js';
import { defaultPolicy } from '../../../src/policy/defaults.js';
import { makeText } from '../../helpers/factories.js';
import { loadFixtureLines } from '../../helpers/fixtures.js';

describe('False positive regression', () => {
  const engine = new DetectionEngine(defaultPolicy.detection);

  const contentCategories = [
    { name: 'code snippets', file: 'benign/code-snippets.txt' },
    { name: 'documentation', file: 'benign/documentation.txt' },
    { name: 'security discussions', file: 'benign/security-discussions.txt' },
    { name: 'customer support', file: 'benign/customer-support.txt' },
    { name: 'prompt engineering', file: 'benign/prompt-engineering.txt' },
  ];

  for (const category of contentCategories) {
    describe(category.name, () => {
      const samples = loadFixtureLines(category.file);

      it(`should load at least 5 ${category.name} samples`, () => {
        expect(samples.length).toBeGreaterThanOrEqual(5);
      });

      it.each(samples.map((sample, i) => ({ sample, i })))(
        `${category.name} sample #$i should not trigger detection`,
        async ({ sample }) => {
          const result = await engine.detect(makeText(sample));
          expect(
            result.action,
            `Expected 'allow' for benign ${category.name}: "${sample.slice(0, 80)}..."`,
          ).toBe('allow');
          expect(
            result.matches,
            `Expected no matches for benign ${category.name}: "${sample.slice(0, 80)}..." but got ${result.matches.map((m) => m.patternId).join(', ')}`,
          ).toHaveLength(0);
        },
      );
    });
  }
});
