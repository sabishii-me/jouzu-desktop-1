# Working in this repository

This repository is QA for Jouzu Desktop and is worked on by agents as well as
people. Read this before changing anything.

## Rules

- Run the app only through `harness/e2e-runtime/abnormal-exam.mjs`: it uses a
  throwaway home and data folder. Never point anything at a real data folder,
  and never stop a process you did not start.
- The harness records and judges what a person sees; it never changes the app.
  A problem in the app is reported, not fixed here.
- Never loosen a check in the same change that makes it pass.
- Never press update, install, sign-out, remove or delete in the app.
- Everything in this repository is in English.
- This repository is public. Record only fixture data, run
  `node tools/scan-public.mjs` before each commit (with `QA_PRIVATE_WORDS` set
  on the machine), and never commit anything it flags.
- A security problem found while testing is never written here, in an issue or
  in a commit: tell the maintainers privately.
- Work on a branch and open a pull request. Only QA and the maintainers merge;
  an author of product code never marks their own change as intended.

## The atlas

- A state id is stable: `<flow>--<state>`, lower case, words joined by `-`.
  Changing an id loses its history; rename only with a reason in the commit.
- One state = one screenshot + its words. Add states to `harness/e2e/ui-states.mjs`
  in the flow they belong to.
- Record with `tools/atlas-build.mjs`; never edit `atlas/` by hand.

## Open work (first audit of the develop UI)

1. Run the tour against the current build and fix the tour's steps where the
   UI moved, so every state it knows is reached again. Report states that can
   no longer be reached and why.
2. Record the atlas for that build: en and ja, dark, desktop window 1280 wide.
3. Add devices: web in a desktop browser (1440x900), iPad (portrait and
   landscape, touch), phone (390x844, touch). Use the installed package's host
   and UI in a test browser for these.
4. Add states the tour does not reach yet, starting with the Assistant pane,
   tasks, Settings tabs, remote access and every error a person can meet.
5. Audit every state against: the error shows where it belongs and only once;
   plain, translated words with no raw technical text; a working way to
   recover; no endless spinner; no layout jump; no contradiction between
   parts of the screen; monochrome line icons only; nothing cut off or in the
   wrong language. List each problem with its state id and screenshot.
