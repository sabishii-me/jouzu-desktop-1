# The case catalog

Every Jouzu Desktop test case is listed here, once, in YAML. The fields follow ISO/IEC/IEEE 29119-3
(test case specification) and the usual test case managers. The playbooks in `harness/e2e` hold the
code that runs a case; the catalog says what the case is. People read `CASES.md`, which is generated
from these files: edit the YAML, never `CASES.md`.

## Files

One file per area: `install-update.yaml`, `sessions.yaml`, `chat.yaml`, `provider-runtime.yaml`,
`settings-input.yaml`, `signin-image-security.yaml`.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Permanent ID, `AREA-123`. Never changed, never reused. A case that is no longer run stays with `automation.status: deferred` and a note. |
| `legacy` | no | Earlier names: playbook numbers (P1), main-scenario numbers (N1), issue numbers (#173), acceptance items (D-upg-1). |
| `title` | yes | What the person does and sees, in one line. |
| `suite` | yes | `smoke` (the most used paths; run first, a failure stops the release run), `main` (main user scenarios), `regression` (a fixed issue, one case per issue), `abnormal` (failures of the network, provider, runtime or files). |
| `scenario` | yes | The user scenario, U1–U12 (U1 new install, U2 update from the last release, U3 update between release candidates, U4 everyday chat, U5 sign-in and models, U6 provider or network trouble, U7 runtime trouble, U8 settings, U9 saved sessions, U10 image tool, U11 folders, U12 security). |
| `priority` | yes | `high`, `medium`, `low`: the order to write and run cases. It is not the severity of a failure; severity (S1–S4) is set by the product owner per finding. |
| `type` | yes | `functional`, `performance`, `install`, `update`, `security`, `i18n`. |
| `purpose` | yes | Why the case exists: what must hold for the person. |
| `preconditions.world` | yes | What the harness prepares: `user` (a person who uses Jouzu: the fixture model, old sessions), `new-user` (nothing prepared), `shisa-stand-in` (Shisa.AI sign-in goes to a local stand-in), `installed-app` (the installed app on a test machine), `installed-package` (an installed package with a throwaway home). |
| `preconditions.state` | no | Anything else that must be true before step 1. |
| `data` | no | The test data. |
| `steps` | yes | A list of `{do, expect}`: what is done and what the person must see. |
| `limits` | no | Numeric lines, each `{what, line, by}`; `by` says who set it (a line nobody decided says so). |
| `measures` | no | Timings the case records (from host.log). |
| `languages` | no | Interface languages it runs in; default all four (en, ja, zh-Hans, zh-Hant). |
| `platforms` | no | `windows`, `macos`, `linux`; default all. |
| `automation.status` | yes | `automated` (with `impl`), `planned` (not written yet), `gap` (cannot be automated now; `reason` says why), `deferred` (put later by a decision; `note` says whose). |
| `automation.impl` | if automated | `{file, case}`: the playbook file in `harness/e2e` and the case's name there. |
| `links` | no | Issues and findings. |
| `added` | no | The version the case was added in. |

## Rules

- `node harness/run/catalog.mjs --check` must pass before any run: every automated entry has its
  code, every case in the code has an entry, and both agree on languages and world. The runner checks
  the same and refuses to start otherwise.
- The runner takes its cases from here (`plan.select` in the release plan: suites, scenarios,
  priorities or ids; nothing = every case). Chosen cases that are not automated are listed in the
  report as "not covered"; they count in the release decision.
- Results are recorded by ID and by the case name (baselines from before the catalog use the name).
- Every case also runs the shared end check (UI-001): nothing floating over the page, no raw technical
  text as a main sentence.
- `node harness/run/catalog.mjs --table release-checks/cases/CASES.md` writes the table people read.
