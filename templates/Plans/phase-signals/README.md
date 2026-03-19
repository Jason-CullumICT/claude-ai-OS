# Phase Signal Files

Cross-session coordination mechanism. When a session completes a phase of work, it writes a signal file here. Another session watching for these files knows what to test.

## Convention

**Signal file name:** `{plan-name}--phase-{N}.signal.md`

**Contents:**
```markdown
# Phase N Complete: {phase title}

**Plan:** Plans/{plan-name}/plan.md
**Completed:** {ISO timestamp}
**Commits:** {commit hashes}

## What changed
- {files modified}

## Tests to run
- {verification commands}
```

**After testing:** The testing session deletes the signal file (or moves to `done/`) so it is not re-processed.

## Active watchers

| Session | Watching for | Action |
|---------|-------------|--------|
| (none yet) | | |

## How to use

### Producer (the session that finishes a phase)
```bash
cat > Plans/phase-signals/my-feature--phase-1.signal.md <<EOF
# Phase 1 Complete: Backend API routes

**Plan:** Plans/my-feature/plan.md
**Completed:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Commits:** $(git log -1 --format=%H)

## What changed
- Source/Backend/src/routes/myFeature.ts
- Source/Backend/tests/myFeature.test.ts

## Tests to run
- cd Source/Backend && npm run test
EOF
```

### Consumer (the session waiting for it)
```bash
# Check for new signals
ls Plans/phase-signals/*.signal.md 2>/dev/null

# After testing, remove the signal
rm Plans/phase-signals/my-feature--phase-1.signal.md
```
