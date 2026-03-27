# Pipeline Optimisations

## Problem

The pipeline wastes tokens and wall-clock time due to several inefficiencies:

1. **Over-provisioned models**: Team routing, traceability-reporter, and verify-reporter use sonnet for mechanical/classification tasks that haiku handles fine
2. **Inspector runs on every cycle**: Full 6-specialist audit on a trivial 1-point TheFixer bug fix is expensive and slow
3. **Late commit risks work loss**: Code only commits after validation (Phase 6) — if the 2-hour timeout hits during validation, implementation work exists only in the container volume
4. **Feedback loops over-scope**: When QA fails, ALL coders re-run even if only one layer (frontend/backend) failed
5. **Dead code**: `LearningsSync` class in lib/ is unused — learnings sync happens via in-worker bash script
6. **Playwright reinstalled every cycle**: ~150MB chromium download per worker, when it could be baked into the image

## Desired Outcome

- Token cost reduced by downgrading mechanical agents to haiku
- Inspector skipped or scoped for low-risk TheFixer cycles
- Code committed earlier to prevent work loss on timeout
- Feedback loops scoped to the failed layer only
- Dead code removed
- Playwright pre-installed in worker image
