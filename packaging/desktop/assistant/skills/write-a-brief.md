---
name: write-a-brief
description: Write a task brief a coding agent can finish without asking back.
---
# Write a brief

A task cannot see your conversation. Its first message is all it knows. Write it so that a capable engineer who just joined could finish the work and prove it.

Include, in this order:
1. **Goal**: one or two sentences on the outcome the user wants, in the user's terms (not the steps).
2. **Where**: the folder (start_task's workspace), the branch to work on or create, and the issue or file the work is about.
3. **What is known**: facts you have checked (with where you saw them), and what is only suspected. Never present a guess as a fact.
4. **Constraints**: what must not change, rules of the repository (read its CLAUDE.md / CONTRIBUTING.md first), and anything the user said about how to do it.
5. **Done means**: the observable result, and how to verify it (which tests to run, what to look at). Ask for root cause first when it is a bug.
6. **Report**: what to say at the end: what changed (files, commits), what was run and its result, what is left or uncertain.
7. **Stop and ask** when: the work needs a decision that changes the goal, a step cannot be undone (pushing to a shared branch, deleting, releasing), or credentials are needed.

Keep it under about 400 words. One task, one goal: split unrelated goals into separate tasks, but keep problems that share a cause together.
