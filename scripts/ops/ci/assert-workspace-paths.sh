#!/usr/bin/env bash

set -euo pipefail

required_paths=("$@")

if [ "${#required_paths[@]}" -eq 0 ]; then
  exit 0
fi

missing_paths=()
for path in "${required_paths[@]}"; do
  if [ -z "${path}" ]; then
    continue
  fi
  if [ ! -e "${path}" ]; then
    missing_paths+=("${path}")
  fi
done

if [ "${#missing_paths[@]}" -gt 0 ]; then
  printf 'Missing required workspace paths:\n' >&2
  printf ' - %s\n' "${missing_paths[@]}" >&2
  exit 1
fi
