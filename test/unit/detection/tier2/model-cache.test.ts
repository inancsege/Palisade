import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCacheRoot,
  modelDirFor,
  isInstalled,
  verifyHash,
  MODEL_SHA,
  MODEL_REPO,
  MODEL_FILES,
} from '../../../../src/detection/tier2/model-cache.js';
import { DetectionError } from '../../../../src/utils/errors.js';

/**
 * Save and restore the two env vars these tests manipulate so manipulation never leaks across
 * tests (or out of the file). beforeEach clears both to a known baseline; afterEach restores the
 * captured originals.
 */
const ENV_KEYS = ['PALISADE_MODELS_DIR', 'XDG_CACHE_HOME'] as const;

describe('tier2 model-cache', () => {
  let saved: Record<string, string | undefined>;
  let tmp: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = mkdtempSync(join(tmpdir(), 'palisade-cache-'));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('resolveCacheRoot precedence', () => {
    it('returns PALISADE_MODELS_DIR verbatim when set (highest precedence)', () => {
      process.env.PALISADE_MODELS_DIR = tmp;
      process.env.XDG_CACHE_HOME = '/should/be/ignored';
      expect(resolveCacheRoot()).toBe(tmp);
    });

    it('falls back to join(XDG_CACHE_HOME, palisade, models) when PALISADE_MODELS_DIR unset', () => {
      process.env.XDG_CACHE_HOME = tmp;
      expect(resolveCacheRoot()).toBe(join(tmp, 'palisade', 'models'));
    });

    it('falls back to join(homedir(), .cache, palisade, models) when both unset', () => {
      expect(resolveCacheRoot()).toBe(join(homedir(), '.cache', 'palisade', 'models'));
    });
  });

  describe('modelDirFor', () => {
    it('joins the cache root with the sha subdir', () => {
      process.env.PALISADE_MODELS_DIR = tmp;
      expect(modelDirFor('abc123')).toBe(join(tmp, 'abc123'));
    });
  });

  describe('isInstalled', () => {
    it('is false for a non-existent model dir', () => {
      process.env.PALISADE_MODELS_DIR = tmp;
      expect(isInstalled('nope')).toBe(false);
    });

    it('is true only when BOTH onnx/model.onnx AND config.json exist', () => {
      process.env.PALISADE_MODELS_DIR = tmp;
      const dir = modelDirFor('sha-x');
      mkdirSync(join(dir, 'onnx'), { recursive: true });

      // Only config.json present → false.
      writeFileSync(join(dir, 'config.json'), '{}');
      expect(isInstalled('sha-x')).toBe(false);

      // Only onnx/model.onnx present → false.
      rmSync(join(dir, 'config.json'));
      writeFileSync(join(dir, 'onnx', 'model.onnx'), 'x');
      expect(isInstalled('sha-x')).toBe(false);

      // Both present → true.
      writeFileSync(join(dir, 'config.json'), '{}');
      expect(isInstalled('sha-x')).toBe(true);
    });
  });

  describe('verifyHash (pure, network-free, fs-free)', () => {
    // sha256('palisade') precomputed.
    const PALISADE_SHA = '31bcf00e541432c9fa66278f0606407d5114079c8ecb5908d9397df51a64438c';

    it('returns true when sha256(buf) === expected (case-insensitive)', () => {
      expect(verifyHash(Buffer.from('palisade'), PALISADE_SHA)).toBe(true);
      expect(verifyHash(Buffer.from('palisade'), PALISADE_SHA.toUpperCase())).toBe(true);
    });

    it('returns false on any mismatch (tamper detection)', () => {
      expect(verifyHash(Buffer.from('palisade'), 'a'.repeat(64))).toBe(false);
      // sha256('tamper') is a different, valid-format digest → still a mismatch for this buffer.
      expect(
        verifyHash(Buffer.from('palisade'), '8a452d1573b7d0ebad5cb04928387a4bf5495027d956d6992f51e966afb50123'),
      ).toBe(false);
    });
  });

  describe('DetectionError code discriminant (BLOCKER 1)', () => {
    it('(a) NEW-CODE: string second arg becomes the code', () => {
      const e = new DetectionError('x', 'tier2_model_missing');
      expect(e.code).toBe('tier2_model_missing');
      expect(e).toBeInstanceOf(DetectionError);
    });

    it('(b) NO-ARG: default code, no cause', () => {
      const e = new DetectionError('x');
      expect(e.code).toBe('DETECTION_ERROR');
      expect(e.cause).toBeUndefined();
    });

    it('(c) EXISTING Error-cause caller preserved: code stays default, cause is the Error', () => {
      const cause = new Error('e');
      const e = new DetectionError('x', cause);
      expect(e.code).toBe('DETECTION_ERROR');
      expect(e.cause).toBe(cause);
    });

    it('string code + Error cause as third arg', () => {
      const cause = new Error('boom');
      const e = new DetectionError('x', 'tier2_model_missing', cause);
      expect(e.code).toBe('tier2_model_missing');
      expect(e.cause).toBe(cause);
    });
  });

  describe('pinned model identity (BLOCKER 2 — reproducibility)', () => {
    it('MODEL_SHA is a concrete 40-char lowercase hex commit, NOT "main"', () => {
      expect(MODEL_SHA).toMatch(/^[0-9a-f]{40}$/);
      expect(MODEL_SHA).not.toBe('main');
    });

    it('MODEL_REPO is the chosen base model', () => {
      expect(MODEL_REPO).toBe('protectai/deberta-v3-base-prompt-injection-v2');
    });

    it('MODEL_FILES pins each required file with a 64-char sha256', () => {
      expect(MODEL_FILES.length).toBeGreaterThan(0);
      for (const f of MODEL_FILES) {
        expect(typeof f.path).toBe('string');
        expect(f.path.length).toBeGreaterThan(0);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      // The ONNX weights + config must be among the pins (these gate isInstalled).
      const paths = MODEL_FILES.map((f) => f.path);
      expect(paths).toContain('config.json');
      expect(paths).toContain('onnx/model.onnx');
    });
  });
});
