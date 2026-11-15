#!/usr/bin/env bash
# Usage: wait-feed-readable.sh <feed-url> <expected-latest.json>
# A freshly uploaded release asset takes a while to be served anonymously
# (404 first, then possibly the previous file). Wait until the feed serves the
# expected content and its installer downloads, backing off for up to about
# six minutes, before calling the release unreadable.
set -u
endpoint="$1"
expected="$2"
readable() {
  curl -fsSL "$endpoint" -o published.json && cmp -s "$expected" published.json || return 1
  asset="$(node -p "require('./published.json').platforms['windows-x86_64'].url")"
  curl -fsSL -o /dev/null "$asset"
}
delay=5
for attempt in $(seq 1 10); do
  if readable; then echo "Readable after $attempt attempt(s)"; exit 0; fi
  sleep "$delay"
  delay=$(( delay * 2 > 60 ? 60 : delay * 2 ))
done
echo "The feed or its installer is still not anonymously readable: $endpoint" >&2
exit 1
