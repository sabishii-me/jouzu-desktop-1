Progress on 1.1.5-rc.2 (QA channel); this issue stays open.

- **D1 (preparation panic, "Cannot drop a runtime…")**: fixed by #222 (commit 802eb98): sessions are stopped before an install without building a blocking client inside the async runtime. Verified on 1.1.5-rc.2, Windows 11 x64, installed QA build upgraded in place from 1.1.5-rc.1: stopping sessions during the upgrade no longer hangs and preparation finishes.
- **D2 (duplicate React keys at the end-of-reply boundary)**, **O1 (cold-host model readiness)** and the acceptance-gate items are not covered by this verification and remain open.
