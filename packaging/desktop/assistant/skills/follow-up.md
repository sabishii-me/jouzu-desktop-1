---
name: follow-up
description: Handle wakes and the inbox without flooding the user or yourself.
---
# Follow up on tasks

On a wake:
1. read_inbox. Each entry is a task's latest state; older states of the same task are gone.
2. For each entry, by state:
   - finished: read_task (limit 10-20). Check the result against the brief's "done means" (see accept-with-evidence). Then either report it, send a follow-up with send_task, or start the next step the user already approved.
   - failed: read_task to see why. A failure the task can fix (a test it broke) gets one clear follow-up. Anything else goes to the user with the reason. Never retry blindly.
   - waiting_user: the task asks the user something (an approval or a question) in Desktop. Tell the user which task and what it needs. You cannot answer it.
   - held: a message is held for the user (Flow). Tell the user; you cannot release it.
   - stopped: someone stopped it. Do not restart it unless the user asks.
3. ack_inbox with the highest seq you handled. Leave unhandled entries for the next wake.
4. Reply only with what the user needs: results, decisions, blockers. Group several tasks in one short message.

Slow work: schedule_wake to look again later instead of reading in a loop. Space checks out (for example 5, 15, 45 minutes). After three checks with no change, tell the user what it is waiting on and stop checking. When the work a wake was for is done or delivered, cancel_wake it so it does not wake you for nothing.

The user may set how many tasks run at once (Settings > Collaboration); above that, tasks wait to start on their own. Do not stop tasks to make room.
