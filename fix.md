# Issue #185 fix

## Changes

- Kept the composer footer layout fix from commits `c969d80` and `c1cefc3`: essential controls remain non-shrinking while the optional steering hint yields available width and truncates instead of overlapping TextGuard.
- Removed the incorrect `textguard` field parsing from session summaries in `apps/desktop/src/session-store.ts`. The host contract does not include TextGuard state in summaries.
- Updated `apps/desktop/e2e/issue185-layout.spec.ts` to deliver TextGuard through a real app-wide `session.notice` event using the runtime wording. The test continues to assert geometry for TextGuard, Model, Stop, Send/Steer, and the optional hint at constrained footer widths.
- Added the running fixture's title metadata and used the app-wide running session established at startup, avoiding an unstable synthetic sidebar selection.

## Verification

- `npm --prefix apps/desktop run build`
- `npm --prefix apps/desktop exec vitest run src/session-store.test.ts` — 40 tests passed
- `npx --prefix apps/desktop playwright test e2e/issue185-layout.spec.ts --reporter=line` — 1 test passed
- `git diff --check`

## Before/after evidence

The original fixture could not establish a valid running session/TextGuard state, so it did not provide a meaningful develop red run. The corrected notice-based fixture renders TextGuard through the production event path, and the fixed layout test passes with the required non-overlap assertions.

## Commits

- Existing layout commits: `c969d80`, `c1cefc3`
- Existing session-summary experiment: `453ed9e` (removed locally; not part of the final change)
- Final fixture/transport corrections are pending commit.
