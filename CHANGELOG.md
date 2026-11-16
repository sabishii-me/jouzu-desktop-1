# Changelog

## 1.1.3-rc.2 - unreleased

- Sessions from earlier Desktop versions are back. 1.1.3-rc.1 looked for Jouzu's data in a
  different folder, so everything created before it was missing from the list. Desktop uses
  the folder it has always used again (`data` in the Desktop folder, or `JOUZU_HOME` when
  set), does not move it between releases and never copies data into or out of it (#112).
- The first message in a new session reaches the model sooner. When the folder has a warm
  runtime ready, a new session attaches to it as soon as it is created, so sending only hands
  over the message instead of first switching the runtime to the session (#117). A new
  session left without a message gives its runtime back as soon as no window shows it.
- Playbook timings are judged by what the app controls: own message and the turn visibly
  working by the median of five new sessions, and the host's part of a reply from host.log.
  The answer's own time (provider and model) is recorded, not gated (#97).

- The stable release exam now enforces the host's part of a first reply (message accepted to
  the model request, from host.log; median 200 ms, slowest 400 ms) instead of only showing
  it in the report (#129).

## 1.1.3-rc.1 - 2026-11-15

First release candidate for 1.1.3, on the QA channel.

- Desktop uses Jouzu's own home (`%LOCALAPPDATA%\Shisa.ai\Jouzu\data`, or `JOUZU_HOME`
  when set) and no longer copies Jouzu's data into a folder of its own, so Desktop and `jz`
  in a terminal show the same sessions, settings and sign-ins (#90).
- Settings has a Web access page. It shows who can connect besides this window and lets
  you allow a browser on this computer, or devices on trusted networks such as your local
  network or Tailscale. Every browser must be paired with a one-time code, and paired
  devices can be removed at any time. Web access stays off until you turn it on (#91).
- A browser on another device opens the web UI over plain http instead of showing a blank
  page, and its copy buttons work (#106).
- The model list is built again after every settings change: models of an account you
  signed out of disappear, and providers added later appear (#84).
- The first start on a fresh install no longer stays on "Connecting to launcher…" after
  Node, the app and Git are installed (#87).
- The QA badge on the icon now comes with the QA package itself, installer included; the
  app no longer changes its icon when you switch the update channel (#74).
- QA releases are release candidates (`X.Y.Z-rc.N`). A stable release is built again from a
  candidate that passed QA, with the normal icon (#86).

## 1.1.2 - 2026-11-15

QA channel fixes.

- The first start after an update no longer stays on "Connecting to launcher…" when a new
  model catalog is activated while the last session opens (#73).
- Language settings can be saved again, in Settings and on the first-run language page (#72).
- A QA installation shows the Jouzu icon with a "QA" badge on the window, taskbar, tray and
  shortcuts, and switches back when you return to stable (#74).
- A turn's "files edited" list appears only under that turn of the session that made it, not
  under other sessions or earlier turns (#79).
- The README and public documentation describe the current design.

## 1.1.1 - 2026-11-15

QA channel fixes.

- A Shisa API key saved in Settings takes effect after "Refresh models", without restarting
  the app (#63).
- The image tool offers a provider only when it can generate images for your account; any
  other provider is listed with the reason it cannot be used (#64).
- The image tool lists every provider the model runtime has image models for, not only
  Shisa.AI, and generates through the runtime with them (#65).
- Settings has a Language page that shows and changes Jouzu's interface and reply language,
  shared with Jouzu in a terminal; first run asks for both before connecting a model (#66).
- Opening Settings → Tools before any tools settings were saved no longer blanks the
  window (#67).

## 1.1.0 - 2026-11-15

First release on the QA channel (Settings → System). It shares your data and sign-ins with
the stable channel, and you can switch back at any time.

- Chat sessions now run through a local host that keeps them alive on its own: closing or
  reloading the window no longer stops a reply, and a window that reconnects catches up.
- Startup keeps a few recent folders ready, so opening a session there does not wait for
  the model runtime to start.
- Messages sent while a reply is running wait in a visible queue and are delivered once, at
  the next step; Stop keeps them so you can continue or discard them.
- Saved conversations open on the model they last used.
- Session problems are shown in one place above the message box, with what to do next;
  there are no more floating notices.
- If the model runtime stops during a reply, the session recovers by itself and the
  unanswered message offers Retry. Flow control no longer shows "holding" after it has
  released.
- A missing bundled Node.js is reported instead of silently using another one.

## 1.0.23 - 2026-11-09

- Restore the session open path to the 2570a2d behaviour: a 4 MB tail preview
  read once, and an authoritative runtime transcript. The desktop-side pager,
  the 256 MB scan and the 20 MB native fallback are gone.
- A transcript above the 32 MiB frame limit is reported as a per-session error
  with a retry instead of dropping the session offline.
- The turn summary reports files created by shell commands, not only by edit
  tools, and renders them as cards instead of collapsing the whole turn.
- Settings blocks the view behind it while it is open.
- Workspace groups stay collapsed once the user collapses them.

## 1.0.11 - 2026-11-03

- Retry the model catalog after a fresh sign-in. The first catalog refresh can
  race a just-issued account key; the chat now retries it instead of leaving a
  signed-in install with an empty model list. If all attempts fail, the model
  menu and the Shisa.AI card in Settings offer an explicit retry.

## 1.0.10 - 2026-11-02

- Fix compact on a large session: the desktop no longer reads the whole
  transcript to attach for compact or after it, so a response above the 32 MiB
  JSONL frame limit can no longer close the session. Compaction changes the
  runtime context; the view keeps the transcript it already has.

## 1.0.9 - 2026-11-02

- Add Codex OAuth to Add Provider: sign in with a ChatGPT Plus/Pro account
  using the same device-code flow as Shisa.AI.

## 1.0.8 - 2026-11-02

- Fix the first-run runtime install: npm lifecycle scripts now find the Node
  that the installer just downloaded, so a machine without a system Node can
  finish provisioning.

## 1.0.1 - 2026-10-23

- Ship the desktop-only installer; the Jouzu runtime is provisioned separately.
- Update the app from the desktop update feed.
- Show the TextGuard review prompt above the composer.
- Add fork, pin and archive session actions.
- Reconcile interrupted tool calls when a session is reopened.

## 0.2.1 - 2026-10-21

- Prepare the standalone desktop product.
- Keep desktop identity independent from the launcher.

## 0.2.0 - 2026-10-20

- Add the Windows launcher with the embedded chat workspace.

