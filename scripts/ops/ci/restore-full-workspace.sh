#!/usr/bin/env bash

set -euo pipefail

timeout_seconds="${CI_SPARSE_RESTORE_TIMEOUT_SECONDS:-180}"
allow_full_disable="${CI_SPARSE_RESTORE_ALLOW_FULL_DISABLE:-0}"

if ! [[ "$timeout_seconds" =~ ^[0-9]+$ ]] || [ "$timeout_seconds" -le 0 ]; then
  echo "CI_SPARSE_RESTORE_TIMEOUT_SECONDS must be a positive integer." >&2
  exit 1
fi

required_paths=("$@")

has_sparse_checkout() {
  local sparse_enabled
  sparse_enabled="$(git config --bool core.sparseCheckout 2>/dev/null || true)"
  [ "$sparse_enabled" = "true" ]
}

path_has_missing_tracked_children() {
  local path="$1"
  local tracked_path
  while IFS= read -r tracked_path; do
    if [ -z "$tracked_path" ]; then
      continue
    fi
    if [ ! -e "$tracked_path" ]; then
      return 0
    fi
  done < <(git ls-files -- "$path")

  return 1
}

path_has_dirty_tracked_children() {
  local path="$1"
  if git diff --quiet --ignore-submodules --ignore-cr-at-eol -- "$path"; then
    return 1
  fi

  return 0
}

path_needs_restore() {
  local path="$1"
  if [ ! -e "$path" ]; then
    return 0
  fi
  if [ -d "$path" ] && path_has_missing_tracked_children "$path"; then
    return 0
  fi
  if path_has_dirty_tracked_children "$path"; then
    return 0
  fi

  return 1
}

ensure_required_paths() {
  local missing=()
  local path
  for path in "${required_paths[@]}"; do
    if [ -z "$path" ]; then
      continue
    fi
    if path_needs_restore "$path"; then
      missing+=("$path")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'Required workspace paths are still missing or dirty after sparse restore:\n' >&2
    printf ' - %s\n' "${missing[@]}" >&2
    exit 1
  fi
}

collect_missing_paths() {
  local missing=()
  local path
  for path in "${required_paths[@]}"; do
    if [ -z "$path" ]; then
      continue
    fi
    if path_needs_restore "$path"; then
      missing+=("$path")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    printf '%s\n' "${missing[@]}"
  fi
}

load_missing_paths() {
  missing_paths=()
  local path
  while IFS= read -r path; do
    missing_paths+=("$path")
  done < <(collect_missing_paths)
}

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${timeout_seconds}s" "$@"
    return $?
  fi

  "$@"
}

restore_required_paths() {
  local missing=("$@")
  if [ "${#missing[@]}" -eq 0 ]; then
    return 0
  fi

  echo "Restoring required workspace paths: ${missing[*]}"
  # Sparse checkouts hide skipped directories unless restore ignores the skip-worktree bit.
  if run_with_timeout git restore --worktree --ignore-skip-worktree-bits -- "${missing[@]}"; then
    return 0
  else
    local status=$?
    if [ "$status" -eq 124 ]; then
      echo "Targeted workspace restore timed out after ${timeout_seconds}s." >&2
    else
      echo "Targeted workspace restore failed with exit code ${status}." >&2
    fi
    return "$status"
  fi
}

sparse_patterns_for_paths() {
  local path
  local tracked_path
  local path_had_tracked
  local path_has_exact_file
  for path in "$@"; do
    if [ -z "$path" ]; then
      continue
    fi

    path_had_tracked=0
    path_has_exact_file=0
    while IFS= read -r tracked_path; do
      if [ -z "$tracked_path" ]; then
        continue
      fi
      path_had_tracked=1
      if [ "$tracked_path" = "$path" ]; then
        path_has_exact_file=1
      fi
    done < <(git ls-files -- "$path")

    if [ "$path_has_exact_file" -eq 1 ]; then
      printf '%s\n' "$path"
    elif [ "$path_had_tracked" -eq 1 ]; then
      # Directory restores must stay compact. Expanding broad roots like apps,
      # scripts, or tests into every tracked child can make non-cone sparse
      # specs huge enough to stall local runners.
      printf '%s/**\n' "${path%/}"
    else
      printf '%s\n' "$path"
    fi
  done | awk 'NF && !seen[$0]++'
}

expand_sparse_checkout() {
  local missing=("$@")
  if [ "${#missing[@]}" -eq 0 ]; then
    return 0
  fi

  echo "Expanding sparse checkout to required paths (timeout=${timeout_seconds}s)."
  # Keep the checkout bounded to the requested paths. Disabling sparse checkout can
  # force an unbounded full-repo materialization on local runners. Directory
  # requests are expanded to tracked children so non-cone sparse specs do not
  # leave a parent directory pattern that fails to materialize descendants.
  if sparse_patterns_for_paths "${missing[@]}" | run_with_timeout git sparse-checkout add --skip-checks --stdin; then
    return 0
  else
    local status=$?
    if [ "$status" -eq 124 ]; then
      echo "Sparse checkout path expansion timed out after ${timeout_seconds}s." >&2
    else
      echo "Sparse checkout path expansion failed with exit code ${status}." >&2
    fi
    return "$status"
  fi
}

load_missing_paths
restore_status=0
restore_failed=0

if [ "${#missing_paths[@]}" -gt 0 ]; then
  if has_sparse_checkout; then
    # Sparse expansion is cheaper and more deterministic than forcing a broad
    # ignored-skip-worktree restore that may fetch many blobs at once.
    if expand_sparse_checkout "${missing_paths[@]}"; then
      load_missing_paths
    else
      restore_status=$?
      restore_failed=1
    fi
  fi

  if [ "${#missing_paths[@]}" -gt 0 ]; then
    if restore_required_paths "${missing_paths[@]}"; then
      restore_status=0
      restore_failed=0
      load_missing_paths
    else
      restore_status=$?
      restore_failed=1
    fi
  fi

  if [ "${#missing_paths[@]}" -gt 0 ] && has_sparse_checkout; then
    echo "Retrying bounded sparse restore after 15s backoff."
    sleep 15
    if expand_sparse_checkout "${missing_paths[@]}"; then
      load_missing_paths
    else
      restore_status=$?
      restore_failed=1
    fi

    if [ "${#missing_paths[@]}" -gt 0 ]; then
      if restore_required_paths "${missing_paths[@]}"; then
        restore_status=0
        restore_failed=0
      else
        restore_status=$?
        restore_failed=1
      fi
    fi
  fi

  load_missing_paths
fi

if [ "${#missing_paths[@]}" -gt 0 ] && has_sparse_checkout && [ "$allow_full_disable" = "1" ]; then
  echo "Breakglass fallback: disabling sparse checkout (timeout=${timeout_seconds}s)."
  if run_with_timeout git sparse-checkout disable; then
    :
  else
    status=$?
    if [ "$status" -eq 124 ]; then
      echo "Sparse checkout disable timed out after ${timeout_seconds}s." >&2
    else
      echo "Sparse checkout disable failed with exit code ${status}." >&2
    fi
    exit "$status"
  fi

  load_missing_paths
fi

if [ "${#missing_paths[@]}" -gt 0 ] && [ "$restore_failed" -eq 1 ]; then
  exit "$restore_status"
fi

ensure_required_paths
