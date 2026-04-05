---
phase: 03-normalizer-hardening
plan: 02
subsystem: detection
tags: [leet-speak, evasion-detection, normalizer, tier1-engine, regex]

# Dependency graph
requires:
  - phase: 03-normalizer-hardening/01
    provides: normalize() with zero-width stripping, homoglyph normalization, markdown stripping; DecodedInput type with 'leet' encoding variant
provides:
  - decodeLeetSpeak() variant decoder function in normalizer.ts
  - Tier1Engine scanning of leet-decoded variants with confidence boost
  - End-to-end evasion detection tests for all four vectors (zero-width, homoglyph, markdown, leet speak)
affects: [detection-engine, tier1-patterns, proxy-scanning]

# Tech tracking
tech-stack:
  added: []
  patterns: [variant-decoder-pattern, confidence-boost-for-decoded-variants]

key-files:
  created: []
  modified:
    - src/detection/tier1/normalizer.ts
    - src/detection/tier1/index.ts
    - test/unit/detection/normalizer.test.ts
    - test/unit/detection/tier1.test.ts

key-decisions:
  - "Leet speak decoding is a separate variant function, not part of normalize() pipeline (per D-08, D-12)"
  - "9-entry LEET_MAP covers security-focused minimal set: 0,1,3,4,5,7,@,$,! (per D-07)"
  - "+0.1 confidence boost for leet-decoded matches (lower than +0.15 for encoding variants to reduce false positive risk)"
  - "Cyrillic S homoglyph is U+0405 (maps to Latin S), not U+0421 (maps to Latin C) -- test correction during TDD"

patterns-established:
  - "Variant decoder pattern: separate functions that return DecodedInput[] for each decoding strategy"
  - "Confidence boost scaling: +0.15 for encoding variants, +0.1 for leet variants"
  - "Description prefix convention: [encoding decoded] or [leet decoded] for traceability"

requirements-completed: [DETH-02]

# Metrics
duration: 5min
completed: 2026-04-05
---

# Phase 03 Plan 02: Leet Speak Decoding Summary

**Leet speak variant decoder (decodeLeetSpeak) with 9-entry LEET_MAP integrated into Tier1Engine scanning pipeline, closing the DETH-02 evasion bypass**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-05T02:46:12Z
- **Completed:** 2026-04-05T02:50:47Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Implemented decodeLeetSpeak() as a standalone variant decoder with 9-entry security-focused LEET_MAP
- Integrated leet-decoded variant scanning into Tier1Engine.scanText() with +0.1 confidence boost and [leet decoded] description prefix
- Added comprehensive end-to-end evasion detection tests proving all four evasion techniques are detected: zero-width chars (DETH-01), homoglyphs (DETH-06), markdown (DETH-05), and leet speak (DETH-02)
- Normal text with numbers ("I have 3 items at $5 each") does not trigger false positive detections

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement decodeLeetSpeak() variant function** - `e779556` (feat) - TDD: RED then GREEN
2. **Task 2: Integrate decodeLeetSpeak into Tier1Engine and add evasion tests** - `07c9231` (feat) - TDD: RED then GREEN

_Note: TDD tasks each had RED (tests fail) then GREEN (implementation passes) phases._

## Files Created/Modified
- `src/detection/tier1/normalizer.ts` - Added LEET_MAP constant, LEET_RE regex, and decodeLeetSpeak() export function
- `src/detection/tier1/index.ts` - Added decodeLeetSpeak import and leet-decoded variant scanning block in scanText()
- `test/unit/detection/normalizer.test.ts` - Added 9 unit tests in describe('decodeLeetSpeak') block
- `test/unit/detection/tier1.test.ts` - Added 8 integration tests across 5 describe blocks (leet speak, zero-width, homoglyph, markdown, combined evasion)

## Decisions Made
- Used simple presence check (`decoded === input`) as the heuristic for detecting leet characters, per RESEARCH.md recommendation
- Set confidence boost at +0.1 (lower than +0.15 for encoding variants) because leet decoding has higher false positive potential
- Corrected homoglyph test to use U+0405 (Cyrillic S -> Latin S) instead of U+0421 (Cyrillic C -> Latin C) for accurate SYSTEM: pattern matching
- decodeLeetSpeak operates on normalized text (after normalize()), not raw input, so zero-width and homoglyph processing happens first

## Deviations from Plan

None - plan executed exactly as written.

Note: A test correction was made during TDD RED phase for the homoglyph evasion test (U+0421 -> U+0405) to match the actual HOMOGLYPH_MAP behavior. This was test authoring accuracy, not a code deviation.

## Issues Encountered

**Pre-existing integration test failure:** `test/integration/proxy-scenarios.test.ts` line 406 ("HTML comment injection") fails on the base commit. The `delimiter:html-comment-injection` pattern's `baseConfidence: 0.75` produces a threat score of ~0.675, below the BLOCK_THRESHOLD of 0.7. This is NOT caused by Plan 03-02 changes. Logged to `deferred-items.md`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Leet speak evasion bypass (DETH-02) is now closed
- All four evasion vectors (zero-width, homoglyph, markdown, leet speak) are detected and tested end-to-end
- Combined multi-vector evasion attacks are decomposed layer by layer
- The decodeLeetSpeak function follows the established variant decoder pattern and can be extended with additional character mappings if needed

## Self-Check: PASSED

- All 5 files verified present on disk
- Commit e779556 verified in git log
- Commit 07c9231 verified in git log
- No stubs or TODOs found in modified source files
- 83/83 unit tests pass, 246/247 suite tests pass (1 pre-existing failure)

---
*Phase: 03-normalizer-hardening*
*Completed: 2026-04-05*
