#!/bin/sh
# Jouzu Desktop: "Mark commits made by the agent" (Settings > Collaboration).
# While that is on, git started by the agent uses this folder as its hooks
# folder (index.js sets it). Every hook here first runs the repository's own
# hook of the same name, unchanged; then prepare-commit-msg adds the trailers.
name=${0##*/}
here=$(cd "${0%/*}" && pwd -P)

# The repository's own hooks folder: what git resolves without our override.
own=$(env "GIT_CONFIG_KEY_${JOUZU_GIT_HOOKS_INDEX:-0}=jouzu.inactive" git rev-parse --git-path hooks 2>/dev/null)
hook=
if [ -n "$own" ] && [ -x "$own/$name" ] && [ "$(cd "$own" 2>/dev/null && pwd -P)" != "$here" ]; then
  hook=$own/$name
fi

if [ "$name" != prepare-commit-msg ]; then
  [ -n "$hook" ] && exec "$hook" "$@"
  exit 0
fi

if [ -n "$hook" ]; then
  "$hook" "$@" || exit $?
fi
# Commits copied from others (cherry-pick, rebase) keep their message as it was.
[ -e "$(git rev-parse --git-path CHERRY_PICK_HEAD)" ] && exit 0
# An empty message must still abort the commit, so it gets nothing added.
grep -v '^#' "$1" | grep -q '[^[:space:]]' || exit 0
# The model and session of the agent that runs this git: the runtime's shell
# tools set them for every command.
model=${PI_MODEL:-} session=${PI_SESSION_ID:-}
model=$(printf '%s' "$model" | tr -d '<>\r\n')
session=$(printf '%s' "$session" | tr -d '<>\r\n')
# The address is the jouzu-desktop GitHub account's own noreply address, so
# GitHub shows that account (and its avatar) as the co-author.
who="Jouzu Desktop"
[ -n "$model" ] && who="Jouzu Desktop ($model)"
# Amending: our earlier lines give way to the current ones, others' lines stay.
sed -e '/^Co-authored-by: Jouzu Desktop.*<359074535+jouzu-desktop@users\.noreply\.github\.com>$/d' -e '/^Jouzu-Session: /d' "$1" > "$1.jouzu" && mv "$1.jouzu" "$1"
# A message without a final newline (git merge -m) would get the trailer glued on.
[ -n "$(tail -c 1 "$1")" ] && echo >> "$1"
set -- "$1" --trailer "Co-authored-by: $who <359074535+jouzu-desktop@users.noreply.github.com>"
[ -n "$session" ] && set -- "$@" --trailer "Jouzu-Session: $session"
file=$1; shift
git interpret-trailers --in-place --if-exists addIfDifferent "$@" "$file" || true
exit 0
