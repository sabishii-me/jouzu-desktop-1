## Summary

While a new session's runtime is still starting, the composer already behaves as if a reply were running: the hint says **"Enter to steer: Jouzu reads it at its next step"** and the button says **Steer**, next to Stop, the status line "Starting session… 00:01" and a spinner on the model button. Nothing has started, so there is no "next step" yet; the screen shows three waiting indicators and one instruction that does not apply.

Seen on 1.1.4-rc.1 (installed).

## Steps to reproduce

Same setup as the slow runtime start in the sidebar issue: make the runtime start slowly, click **New session**, send a message, and look at the composer while "Starting session…" shows.

Expected: while starting, one waiting indicator (the status line); the composer keeps "Send" and its normal hint.

Actual: as above.
