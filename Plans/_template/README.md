# Plan Template

Every feature or change request should have a plan directory under `Plans/`. This template shows the recommended structure.

## Directory Structure

```
Plans/
  my-feature/
    prompt.md          # Original request or problem statement
    design.md          # Design decisions and trade-offs
    plan.md            # Implementation plan with phases
    requirements.md    # Formal FR-XXX requirements (if using TheATeam)
```

## prompt.md

The original problem statement or feature request. Keep it concise.

```markdown
# Feature: User Dashboard

## Problem
Users have no way to see their activity summary at a glance.

## Desired Outcome
A dashboard page showing recent activity, key metrics, and quick actions.
```

## design.md

Architecture and design decisions. Include trade-offs considered.

```markdown
# Design: User Dashboard

## Approach
Single-page dashboard with three widget sections.

## Trade-offs
- Server-side aggregation vs client-side: chose server-side for performance
- Real-time updates vs polling: chose polling (simpler, sufficient for v1)

## API Changes
- GET /api/dashboard/summary
- GET /api/dashboard/activity?limit=10
```

## plan.md

Phased implementation plan. Each phase should be independently testable.

```markdown
# Plan: User Dashboard

## Phase 1: Backend API (backend-only)
- [ ] Create dashboard service
- [ ] Add summary endpoint
- [ ] Add activity endpoint
- [ ] Write tests

## Phase 2: Frontend UI (frontend-only)
- [ ] Create DashboardPage component
- [ ] Add routing
- [ ] Wire up API calls
- [ ] Write tests

## Phase 3: Polish
- [ ] Loading states
- [ ] Error handling
- [ ] Responsive layout
```

## requirements.md

Formal functional requirements for TheATeam pipeline. Each FR has an ID, layer tag, complexity weight, and acceptance criteria.

```markdown
# Requirements: User Dashboard

## FR-DASH-001 [backend] [M]
**Dashboard summary endpoint**
- Returns aggregated metrics for the authenticated user
- AC: GET /api/dashboard/summary returns {totalItems, recentCount, lastActive}

## FR-DASH-002 [frontend] [L]
**Dashboard page with widgets**
- Three-column layout with summary, activity feed, and quick actions
- AC: Page renders all three widgets with data from API
- AC: Loading skeletons shown while fetching
- AC: Error state shown on API failure
```
