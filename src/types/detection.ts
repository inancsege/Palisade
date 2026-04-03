import type { PatternCategory } from './verdict.js';

export interface PatternDefinition {
  id: string;
  name: string;
  category: PatternCategory;
  regex: string;
  flags?: string;
  baseConfidence: number;
  weight: number;
  description: string;
  tags?: string[];
  enabled?: boolean;
}

export interface CompiledPattern {
  definition: PatternDefinition;
  regex: RegExp;
}
