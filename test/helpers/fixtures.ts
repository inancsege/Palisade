import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures');

export function loadFixture(relativePath: string): string {
  return readFileSync(resolve(FIXTURES_DIR, relativePath), 'utf-8');
}

export function loadFixtureLines(relativePath: string): string[] {
  return loadFixture(relativePath)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}
