# Feature: Tiered Merge Pipeline

## Problem

The current pipeline builds code and runs static/dynamic QA, but has no path from "cycle complete" to "merged to main." Users must manually test in the browser, manually review branches, and manually merge. This creates a bottleneck that blocks parallel cycle throughput and allows incomplete work to ship.

## Desired Outcome

An automated merge pipeline that:
1. Classifies task risk (low/medium/high) during planning
2. Generates Playwright E2E tests during QA that verify features in a real browser
3. Runs those E2E tests against the live app as a hard merge gate
4. Creates GitHub PRs automatically via `gh` CLI
5. Runs AI PR review for medium/high risk tasks
6. Auto-merges low and medium risk (when gates pass); high risk waits for human approval

## Source Spec

`docs/superpowers/specs/2026-03-25-tiered-merge-pipeline-design.md`

## Scope (Phase 1 only)

Per the spec's migration plan, this implements Phase 1:
- Risk classification in leader prompt
- E2E test generation prompt in QA agents
- Playwright E2E runner phase in workflow engine
- Auto-PR creation via gh CLI
- AI PR review agent
- Auto-merge decision logic

Phase 2 (post-merge Chrome validation, auto-revert) and Phase 3 (webhooks, branch protection) are deferred.
