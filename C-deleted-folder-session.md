## Summary

Opening a saved session whose working folder was deleted:

- replaces the composer with "The runtime could not open this session." and the button **Restart session**. The cause is that the folder no longer exists, and restarting cannot fix that;
- moves the session in the sidebar: before opening it is listed under its own folder's group (for example `deleted-folder`); after opening it is listed under **Default workspace** and the old group disappears.

Seen on 1.1.4-rc.1 (installed).

## Steps to reproduce

1. Add a folder, for example `C:\tmp\ui-test`, and have one session in it with at least one reply.
2. Quit the app (also from the tray).
3. Delete or rename `C:\tmp\ui-test`.
4. Start the app. The sidebar shows a group `ui-test` with the session.
5. Click the session.

Expected: one plain reason ("This session's folder no longer exists"), and only actions that help (read the history; continue in another folder). The session stays in its own group.

Actual: "The runtime could not open this session." + **Restart session**; the session now shows under "Default workspace" and the `ui-test` group is gone.

## Proposed fix

Recognize the missing folder before starting a runtime, say so, offer only actions that work, and keep the session's workspace as saved.
