#!/bin/sh
set -eu

: "${MSB_HOME:?Set MSB_HOME to a short, dedicated directory with the cached image}"
case "$MSB_HOME" in
  /*) ;;
  *) printf 'MSB_HOME must be absolute\n' >&2; exit 2 ;;
esac
msb=$(command -v msb)
image=docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd
fixture=$(mktemp -d "$MSB_HOME/smoke.XXXXXX")
name="smoke-${fixture##*.}"

run_msb() {
  env -i PATH=/usr/bin:/bin MSB_BACKEND=local MSB_HOME="$MSB_HOME" "$msb" "$@"
}

cleanup() {
  run_msb stop --force "$name" >/dev/null 2>&1 || :
  run_msb rm "$name" >/dev/null 2>&1 || :
}
mkdir "$fixture/repo" "$fixture/scratch"
printf 'synthetic repository\n' >"$fixture/repo/source.txt"
printf 'synthetic host only\n' >"$fixture/unmounted.txt"

run_msb create --name "$name" --pull never --no-net --max-duration 2m \
  --mount-dir "$fixture/repo:/fixture:ro" \
  --mount-dir "$fixture/scratch:/scratch:rw" "$image"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Started sandbox %s\n' "$name"
run_msb exec --no-stdin --no-tty --timeout 10s "$name" -- /bin/sh -ec '
  test "$(uname -s)" = Linux
  test "$(cat /fixture/source.txt)" = "synthetic repository"
  if (printf "must fail\n" >/fixture/unexpected.txt); then
    echo "read-only fixture accepted a write" >&2
    exit 1
  fi
  test ! -e "$1"
  echo "guest scratch write" >/scratch/result.txt
  echo "Guest fixture checks passed"
' sh "$fixture/unmounted.txt"
test ! -e "$fixture/repo/unexpected.txt"
test "$(cat "$fixture/scratch/result.txt")" = "guest scratch write"

started_at=$(date +%s)
set +e
timeout_output=$(run_msb exec --no-stdin --no-tty --timeout 1s "$name" -- /bin/sh -ec '
  printf "started\n" >/scratch/sleep.started
  sleep 30
  printf "completed\n" >/scratch/sleep.completed
' 2>&1)
timeout_status=$?
set -e
elapsed=$(( $(date +%s) - started_at ))
printf '%s\n' "$timeout_output"
test "$timeout_status" -ne 0
test "$elapsed" -lt 10
case "$timeout_output" in
  *'exec timed out after 1s'*) ;;
  *) echo "Expected an exec timeout" >&2; exit 1 ;;
esac
test "$(cat "$fixture/scratch/sleep.started")" = started
test ! -e "$fixture/scratch/sleep.completed"
printf 'Guest command timed out after %s second(s) of wall time\n' "$elapsed"
run_msb ping "$name"

run_msb stop "$name"
run_msb wait "$name" --timeout 10s --format json
run_msb rm "$name"
trap - EXIT
