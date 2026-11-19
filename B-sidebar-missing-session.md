## Summary

A message sent in a new session while its runtime is still starting is on screen, but the sidebar says that workspace has **No sessions yet**, and the header shows the workspace name instead of the session title. The session exists in the conversation and does not exist in the sidebar.

Seen on 1.1.4-rc.1 (installed).

## Steps to reproduce

1. Make the runtime start slowly. The simplest way: start the app and use a workspace whose runtime is not warm yet (first session after start on a slow or busy machine), or end the `node.exe` runtime processes of the app in Task Manager and wait a moment. (Our test delayed the runtime start by 8 s.)
2. Click **New session** in a workspace that has no sessions yet.
3. Type a message and press Send while the composer still shows the spinner on the model button / "Starting session…".
4. Look at the sidebar and the header during the start.

Expected: the session is listed under its workspace as soon as the message is sent (titled by the first message), and the header shows that title.

Actual: until the runtime has written the session, the sidebar says "No sessions yet" under the workspace and the header shows "Default workspace" (the workspace name), while the conversation already shows the sent message and "Starting session… 00:01".

## Root cause (to confirm)

The sidebar appears to list only sessions that the runtime has already saved to disk, not the host session that exists from the moment of the send.

## Proposed fix

List a host session in the sidebar as soon as it exists, titled by its first message.
