## Summary

A provider that answers with a server error (HTTP 500) is reported as **"The provider did not answer"**, both in the retry line ("Model request failed, retrying 1/3 (The provider did not answer)") and on the failed reply. A lost network connection shows exactly the same words. The provider did answer; two different causes read the same, and the person cannot tell whether to check their network or wait for the provider.

Seen on 1.1.4-rc.1 (installed), en and ja.

## Steps to reproduce

1. Add a custom OpenAI-compatible provider whose base URL points at a server that answers every request with HTTP 500 (any small local stub works).
2. Send a message with that provider's model.
3. Read the retry line and, after the retries, the failed reply.
4. Compare: point the provider at an address with no server, or disconnect the network, and send again.

Expected: 500 → "The provider had an error" (or similar); no connection → "Could not reach the provider".

Actual: both show "The provider did not answer" (`replyUnavailable` in `apps/launcher/src/chat-text.ts`).
