# Token Priority Chain

## Problem

The orchestrator currently uses a single auth strategy: mounting `~/.claude/.credentials.json` from the Docker host. This means:
- All workers share the same credential
- No way to submit work using a different user's token
- No fallback if the host credential file is missing or expired
- CI environments without a host credentials file have no path

## Design

### Priority Chain

When a workflow starts, resolve the Claude session token using this priority (first available wins):

1. **Per-request token** — `claudeSessionToken` field on `/api/work` body
2. **Host credentials** — `~/.claude/.credentials.json` mounted from Docker host
3. **Env fallback** — `CLAUDE_SESSION_TOKEN` from `.env`

### Run Metadata

Each run stores token provenance but **never the token value**:

```json
{
  "tokenSource": "api|host|env",
  "tokenLabel": "jason's token"
}
```

### Owner Identification

When a per-request token is provided, attempt to identify the owner:
1. Try calling `https://api.anthropic.com/v1/me` (or equivalent) with the token
2. If that returns a user profile, extract the display name
3. If unavailable, use the optional `tokenLabel` field from the caller
4. Final fallback: `"custom token"`

### API Changes

`POST /api/work` accepts two new optional fields:

| Field | Type | Description |
|-------|------|-------------|
| `claudeSessionToken` | string | OAuth access token (`sk-ant-oat01-...`) |
| `tokenLabel` | string | Human-readable label (e.g., "jason's token") |

### File Changes

| File | Change |
|------|--------|
| `token-pool.js` | New `resolveToken(perRequestToken?)` method implementing the priority chain. Returns `{ token, source, label }` |
| `container-manager.js` | `refreshCredentials(containerId, tokenOverride?)` accepts an optional token string instead of always reading from the host file |
| `server.js` `/api/work` | Accept `claudeSessionToken` and `tokenLabel`, pass to workflow engine |
| `workflow-engine.js` | Resolve token at workflow start, pass to `refreshCredentials` throughout the pipeline, store `tokenSource` and `tokenLabel` on run |

### Security

- Token values are held in memory only during the workflow execution
- Never persisted to run JSON files
- Never included in API responses
- Cleared from memory when the workflow completes
- The `tokenLabel` and `tokenSource` fields are safe to persist and display

### Credential Injection Flow

```
/api/work { claudeSessionToken: "sk-ant-..." }
    │
    ▼
tokenPool.resolveToken(perRequestToken)
    │ returns { token, source: "api", label: "jason's token" }
    ▼
run.tokenSource = "api"
run.tokenLabel = "jason's token"
    │
    ▼
workflowEngine.executeWorkflow(run, saveRun, resolvedToken)
    │
    ├─► containerManager.refreshCredentials(containerId, resolvedToken)
    │       writes token to /root/.claude/.credentials.json inside worker
    │
    ├─► [before each agent exec] refreshCredentials(containerId, resolvedToken)
    │
    └─► [workflow complete] resolvedToken falls out of scope
```
