#!/bin/sh
# Self-test of the runner with a stand-in exam: no app, no browser. Expected: every case
# recorded, Hangs/Crashes as ERROR, both re-run 3 times, the run reaches the end.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
RUN_SELFTEST=1 RUN_EXAM="$here/fake-exam.mjs" RUN_CATALOG="$here/cases" ABN_LANGS=en,ja node "$here/../run-suite.mjs" --plan "$here/plan.json" --out "$out" --machine selftest
mkdir -p "$out/accept" && echo shot > "$out/accept/c1.txt"
node "$here/../record.mjs" --out "$out" --plan "$here/plan.json" --machine selftest --id C1 --result PASS --actual "It opened" --evidence accept/c1.txt
node "$here/../report.mjs" --out "$out" --plan "$here/plan.json"
cat "$out/report.md"
echo "OUT=$out"
