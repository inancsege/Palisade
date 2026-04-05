# Deferred Items - Phase 03: Normalizer Hardening

## Pre-existing Test Failure

**File:** `test/integration/proxy-scenarios.test.ts` line 406
**Test:** "Delimiter escape attacks (should BLOCK) > HTML comment injection"
**Issue:** The `delimiter:html-comment-injection` pattern has `baseConfidence: 0.75` and `weight: 0.8`, which produces a threat score of ~0.675 (below the 0.7 BLOCK_THRESHOLD). The test expects HTTP 403 (blocked) but gets 200 (allowed).
**Root cause:** The pattern's confidence/weight values are too low for a single-category match to reach the block threshold.
**Verified:** Failure exists on the base commit (5ef05e3) before any Plan 03 changes.
**Suggested fix:** Either increase the pattern's `baseConfidence` to 0.85+ or add a second matching pattern for HTML comment content.
