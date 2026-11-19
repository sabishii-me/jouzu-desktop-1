# Files the UI state audit issues on shisa-ai/jouzu-desktop (unassigned) and comments on #100.
$ErrorActionPreference = 'Stop'
$repo = 'shisa-ai/jouzu-desktop'
$items = @(
  @{ f='A-older-stable-as-update.md'; s='medium'; t='An older stable build is offered as an update (tag, primary button, sidebar mark, "What''s new")' },
  @{ f='B-sidebar-missing-session.md'; s='medium'; t='A session sent while its runtime starts is missing from the sidebar ("No sessions yet")' },
  @{ f='C-deleted-folder-session.md'; s='medium'; t='Session whose folder was deleted: says the runtime failed, offers Restart session, and moves to another workspace' },
  @{ f='D-system-version-names.md'; s='low'; t='Settings > System: the app''s own version sits under "Launcher" while "Jouzu" shows the runtime' },
  @{ f='E-500-did-not-answer.md'; s='low'; t='A provider server error (500) is shown as "The provider did not answer", the same words as no network' },
  @{ f='F-steer-while-starting.md'; s='low'; t='While a new session starts, the composer offers Steer and "reads it at its next step"' },
  @{ f='G-tools-not-signed-in.md'; s='low'; t='Settings > Tools repeats "not signed in" once per image provider' }
)
foreach ($i in $items) {
  $url = gh issue create --repo $repo --title $i.t --body-file (Join-Path $PSScriptRoot $i.f) --label bug --label "severity: $($i.s)"
  Write-Output "$($i.f) -> $url"
}
gh issue comment 100 --repo $repo --body-file (Join-Path $PSScriptRoot 'comment-100.md')
Write-Output 'commented on #100'
