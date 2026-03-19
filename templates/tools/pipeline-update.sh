#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not found. Install it: https://jqlang.github.io/jq/download/" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse arguments
TEAM="" AGENT="" ACTION="" NAME="" MODEL="" VERDICT="" METRICS="" STATUS="" RUN_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --team)    TEAM="$2"; shift 2 ;;
    --agent)   AGENT="$2"; shift 2 ;;
    --action)  ACTION="$2"; shift 2 ;;
    --name)    NAME="$2"; shift 2 ;;
    --model)   MODEL="$2"; shift 2 ;;
    --verdict) VERDICT="$2"; shift 2 ;;
    --metrics) METRICS="$2"; shift 2 ;;
    --status)  STATUS="$2"; shift 2 ;;
    --run)     RUN_ID="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$TEAM" || -z "$ACTION" ]]; then
  echo "Usage: $0 --team TEAM --action ACTION [--run RUN_ID] [--agent AGENT_KEY] [options]" >&2
  exit 1
fi
if [[ "$ACTION" != "pipeline-status" && "$ACTION" != "init" && -z "$AGENT" ]]; then
  echo "ERROR: --agent is required for action '$ACTION'" >&2
  exit 1
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATE_FILE="$SCRIPT_DIR/pipeline-state-${TEAM}.json"
INDEX_FILE="$SCRIPT_DIR/pipeline-index.json"
LOCK_DIR="${STATE_FILE}.lock"

# --- File locking (mkdir-based) ---
acquire_lock() {
  local deadline=$((SECONDS + 5))
  while true; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      return 0
    fi
    # Stale lock detection: if lock dir mtime > 30s, remove and retry
    if [[ -d "$LOCK_DIR" ]]; then
      local lock_age=999
      if stat --version &>/dev/null 2>&1; then
        # GNU stat
        local lock_mtime
        lock_mtime=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
        local now_epoch
        now_epoch=$(date +%s)
        lock_age=$(( now_epoch - lock_mtime ))
      else
        # BSD stat (macOS)
        local lock_mtime
        lock_mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)
        local now_epoch
        now_epoch=$(date +%s)
        lock_age=$(( now_epoch - lock_mtime ))
      fi
      if (( lock_age > 30 )); then
        rmdir "$LOCK_DIR" 2>/dev/null || true
        continue
      fi
    fi
    if (( SECONDS >= deadline )); then
      echo "ERROR: Could not acquire lock on $STATE_FILE after 5 seconds" >&2
      exit 1
    fi
    sleep 0.1
  done
}

release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

# Always release lock on exit
trap release_lock EXIT

acquire_lock

# --- Ensure state file exists in multi-run format ---
if [[ ! -f "$STATE_FILE" ]]; then
  echo "{\"team\":\"$TEAM\",\"next_run_number\":1,\"runs\":{}}" > "$STATE_FILE"
fi

# --- Migration: detect old single-run format and convert ---
migrate_if_needed() {
  local has_pipeline
  has_pipeline=$(jq 'has("pipeline")' "$STATE_FILE")
  if [[ "$has_pipeline" == "true" ]]; then
    local old_id
    old_id=$(jq -r '.pipeline.id // "legacy-run"' "$STATE_FILE")
    jq --arg team "$TEAM" --arg id "$old_id" '{
      team: $team,
      next_run_number: 2,
      runs: {
        ($id): (. + { number: 1 })
      }
    }' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
}
migrate_if_needed

# --- Ensure index file exists and register team ---
if [[ ! -f "$INDEX_FILE" ]]; then
  echo '{"teams":{}}' > "$INDEX_FILE"
fi
jq --arg t "$TEAM" --arg f "pipeline-state-${TEAM}.json" \
  '.teams[$t] = {"file": $f}' "$INDEX_FILE" > "${INDEX_FILE}.tmp"
mv "${INDEX_FILE}.tmp" "$INDEX_FILE"

# --- Auto-pruning: keep max 50 runs, remove oldest completed/failed first ---
auto_prune() {
  local count
  count=$(jq '.runs | length' "$STATE_FILE")
  if (( count > 50 )); then
    local to_remove=$(( count - 50 ))
    jq --argjson n "$to_remove" '
      .runs as $runs |
      [ $runs | to_entries[]
        | select(.value.pipeline.status != "running")
      ] | sort_by(.value.updated_at) | .[:$n] | map(.key) as $keys |
      reduce $keys[] as $k (.; del(.runs[$k]))
    ' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
}

# --- Resolve target run ---
resolve_run() {
  if [[ -n "$RUN_ID" ]]; then
    local exists
    exists=$(jq --arg r "$RUN_ID" '.runs | has($r)' "$STATE_FILE")
    if [[ "$exists" != "true" ]]; then
      echo "ERROR: Run '$RUN_ID' not found in $STATE_FILE" >&2
      exit 1
    fi
    return 0
  fi

  local running_ids
  running_ids=$(jq -r '[.runs | to_entries[] | select(.value.pipeline.status == "running") | .key] | .[]' "$STATE_FILE")
  local running_count
  running_count=$(echo "$running_ids" | grep -c . 2>/dev/null || echo 0)

  if (( running_count == 1 )); then
    RUN_ID="$running_ids"
  elif (( running_count == 0 )); then
    echo "ERROR: No active runs for $TEAM. Use --action init to create one, or pass --run RUN_ID." >&2
    exit 1
  else
    echo "ERROR: Multiple active runs for $TEAM. Pass --run RUN_ID to specify which." >&2
    echo "Active runs:" >&2
    echo "$running_ids" | while read -r id; do echo "  $id" >&2; done
    exit 1
  fi
}

# --- Helper: atomic write with updated_at on the run ---
write_state() {
  local tmp="${STATE_FILE}.tmp"
  jq --arg r "$RUN_ID" --arg now "$NOW" '.runs[$r].updated_at = $now' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
  auto_prune
}

# --- Helper: compute duration ---
compute_duration() {
  local started="$1"
  local dur=0
  if [[ -n "$started" ]]; then
    local s_epoch n_epoch
    s_epoch="$(date -d "$started" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$started" +%s 2>/dev/null || echo 0)"
    n_epoch="$(date -d "$NOW" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$NOW" +%s 2>/dev/null || echo 0)"
    dur=$(( n_epoch - s_epoch ))
  fi
  echo "$dur"
}

# === ACTION DISPATCH ===

case "$ACTION" in
  init)
    RUN_ID="run-$(date -u +%Y%m%d-%H%M%S)"

    TASK_TITLE=""
    if [[ -n "$METRICS" ]]; then
      TASK_TITLE=$(echo "$METRICS" | jq -r '.task_title // empty' 2>/dev/null || true)
    fi

    jq --arg r "$RUN_ID" --arg now "$NOW" --arg title "$TASK_TITLE" '
      .runs[$r] = {
        number: .next_run_number,
        pipeline: {
          id: $r,
          status: "running",
          started_at: $now,
          task_title: (if $title != "" then $title else null end)
        },
        stages: [],
        agents: {},
        feedback_loops: [],
        updated_at: $now
      } |
      .next_run_number = (.next_run_number + 1)
    ' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"

    if [[ -n "$AGENT" ]]; then
      jq --arg r "$RUN_ID" --arg a "$AGENT" --arg now "$NOW" --arg name "$NAME" --arg model "$MODEL" '
        .runs[$r].agents[$a] = {
          status: "running",
          started_at: $now
        } |
        (if $name != "" then .runs[$r].agents[$a].name = $name else . end) |
        (if $model != "" then .runs[$r].agents[$a].model = $model else . end)
      ' "$STATE_FILE" > "${STATE_FILE}.tmp"
      mv "${STATE_FILE}.tmp" "$STATE_FILE"
    fi

    auto_prune

    # Print run ID to stdout (critical -- team leader captures this)
    echo "$RUN_ID"
    ;;

  start)
    resolve_run
    jq --arg r "$RUN_ID" --arg a "$AGENT" --arg now "$NOW" --arg name "$NAME" --arg model "$MODEL" '
      .runs[$r].agents[$a] = (.runs[$r].agents[$a] // {}) |
      .runs[$r].agents[$a].status = "running" |
      .runs[$r].agents[$a].started_at = $now |
      (if $name != "" then .runs[$r].agents[$a].name = $name else . end) |
      (if $model != "" then .runs[$r].agents[$a].model = $model else . end)
    ' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
    write_state
    ;;

  update)
    resolve_run
    jq --arg r "$RUN_ID" --arg a "$AGENT" --arg metrics "$METRICS" '
      .runs[$r].agents[$a].iteration = ((.runs[$r].agents[$a].iteration // 0) + 1) |
      (if $metrics != "" then .runs[$r].agents[$a].metrics = ((.runs[$r].agents[$a].metrics // {}) * ($metrics | fromjson)) else . end)
    ' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
    write_state
    ;;

  complete)
    resolve_run
    STARTED="$(jq -r --arg r "$RUN_ID" --arg a "$AGENT" '.runs[$r].agents[$a].started_at // empty' "$STATE_FILE")"
    DURATION=$(compute_duration "$STARTED")
    jq --arg r "$RUN_ID" --arg a "$AGENT" --arg now "$NOW" --argjson dur "$DURATION" --arg verdict "$VERDICT" --arg metrics "$METRICS" '
      .runs[$r].agents[$a].status = "complete" |
      .runs[$r].agents[$a].completed_at = $now |
      .runs[$r].agents[$a].duration_s = $dur |
      (if $verdict != "" then .runs[$r].agents[$a].verdict = $verdict else . end) |
      (if $metrics != "" then .runs[$r].agents[$a].metrics = ((.runs[$r].agents[$a].metrics // {}) * ($metrics | fromjson)) else . end) |
      (if $a == "team_leader" then .runs[$r].pipeline.status = "complete" | .runs[$r].pipeline.completed_at = $now else . end)
    ' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
    write_state
    ;;

  fail)
    resolve_run
    STARTED="$(jq -r --arg r "$RUN_ID" --arg a "$AGENT" '.runs[$r].agents[$a].started_at // empty' "$STATE_FILE")"
    DURATION=$(compute_duration "$STARTED")
    jq --arg r "$RUN_ID" --arg a "$AGENT" --arg now "$NOW" --argjson dur "$DURATION" '
      .runs[$r].agents[$a].status = "failed" |
      .runs[$r].agents[$a].completed_at = $now |
      .runs[$r].agents[$a].duration_s = $dur |
      (if $a == "team_leader" then .runs[$r].pipeline.status = "failed" | .runs[$r].pipeline.completed_at = $now else . end)
    ' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
    write_state
    ;;

  pipeline-status)
    if [[ -z "$STATUS" ]]; then
      echo "ERROR: --status required for pipeline-status action" >&2
      exit 1
    fi
    resolve_run
    jq --arg r "$RUN_ID" --arg s "$STATUS" '.runs[$r].pipeline.status = $s' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
    write_state
    ;;

  *)
    echo "ERROR: Unknown action '$ACTION'. Use: init|start|update|complete|fail|pipeline-status" >&2
    exit 1
    ;;
esac
