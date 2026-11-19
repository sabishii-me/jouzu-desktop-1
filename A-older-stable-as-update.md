## Summary

When a QA build runs on the **Stable** update channel, Settings → System offers the older stable build (1.0.23) as if it were an update. The same row says both "update" and "older":

- an **Update available** tag next to "Launcher";
- the primary button **Update and restart** (its confirmation says "The launcher restarts after updating");
- the sidebar's update button turns into **Update available** (arrow icon);
- a **What's new** box with the release notes of 1.0.23, which are changes this build already has;
- and one small line: "Back to Stable (older than this build) 1.0.23".

Seen on 1.1.4-rc.1 (installed) and 1.1.3-rc.3.

## Steps to reproduce

1. Install a QA release (for example `v1.1.4-rc.1`). A fresh install follows Stable (#85 decided not to change that).
   On an existing install, open Settings → System and set **Update channel** to **Stable**.
2. Stay on Settings → System and wait for the update check (or press the refresh button at the top right).
3. Look at the Launcher row and at the update button at the bottom of the sidebar.

Expected: the row says that this is a test build and that Stable has an older version, with a plain (not primary) button such as "Install Stable 1.0.23". No "Update available" tag, no sidebar update mark, no "What's new". The confirmation says it installs an older version.

Actual: the older build is shown like a normal update (list above). Switching the channel to QA makes it "Up to date" and the sidebar icon goes back to the plain refresh icon.

## Root cause

- `apps/launcher/src-tauri/src/update_channel.rs` `update_check` returns the older stable build as an ordinary offer with `downgrade: true`.
- `apps/launcher/src/update-preview.tsx` puts that offer in the same `available` phase as a real update; only the line under the button changes (`t.back`). Tag, button label, primary style, confirmation text and "What's new" stay the update ones.
- `apps/launcher/src/App.tsx` passes `updateAvailable={!!(updater.version || jouzuUpdater.version)}` to the sidebar, which ignores `downgrade`.

## Proposed fix

Give "an older stable build is offered" its own state in the update row: no tag, no sidebar mark, a non-primary button "Install Stable <version>", a confirmation that says it is older, and no "What's new". Only the display changes; the channel default (#85) stays as decided.
