#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

cd "${1:?Frozen Edge workdir is required}"
[[ -f SHA256SUMS && ! -L SHA256SUMS ]]
actual=$(find . ! -type d ! -path './SHA256SUMS' -printf '%y %P\n' | sort)
expected=$(awk '{print "f " $2}' SHA256SUMS | sort)
diff -q \
  <(printf '%s\n' "$actual") \
  <(printf '%s\n' "$expected")
sha256sum --strict --check SHA256SUMS
