# Jouzu Desktop test cases

Generated from release-checks/cases/*.yaml by `node harness/run/catalog.mjs --table`. Edit the YAML, not this file.

80 cases: 66 automated, 10 planned, 1 gap, 3 deferred.

## smoke (5)

| ID | Old | Title | Scenario | Priority | Platforms | Languages | Automation |
|---|---|---|---|---|---|---|---|
| CHAT-001 | P7 | A new session answers at once | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| CHAT-003 | P11 | Stop while a tool runs | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| INST-001 | N1 | A new user's first run | U1 | high | all | en, ja | automated (release-playbook.mjs) |
| UPD-001 | N2 D-upg-1 | Update from the last release keeps sessions, settings and sign-ins | U2 | high | windows | all | planned |
| START-001 | P1 | Cold start opens the last session | U4 | high | all | en, ja | automated (release-playbook.mjs) |

## main (31)

| ID | Old | Title | Scenario | Priority | Platforms | Languages | Automation |
|---|---|---|---|---|---|---|---|
| CHAT-002 | P8 | A new session while another one is running | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| CHAT-004 | P12 | Switching the model | U5 | high | all | en, ja | automated (release-playbook.mjs) |
| CHAT-005 | P13 | A question or approval from the agent | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| CHAT-006 | P23 | A reply with many steps keeps every step on screen | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| CHAT-007 | P24 | The status line says what the reply is doing | U4 | medium | all | en, ja | automated (release-playbook.mjs) |
| CHAT-008 | P25 | Automatic retry and context compaction are shown | U6 | medium | all | en, ja | automated (release-playbook.mjs) |
| CHAT-009 | P26 | A tool stopped or cut off shows as interrupted | U7 | high | all | en, ja | automated (release-playbook.mjs) |
| CHAT-010 | P27 | Two messages sent while a reply runs are each used once | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| CHAT-011 | P28 | Queued messages can be deleted, edited and kept on Stop | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| CHAT-012 | P21 | TextGuard per session (on, strict, off) | U8 | low | all | all | deferred |
| CHAT-013 | P22 | A request held by Flow | U4 | low | all | all | deferred |
| CHAT-014 | P20 | Web access from this computer and another device | U4 | low | all | all | deferred |
| UI-001 | P29 | Problems and notices are shown in their place | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| INST-002 | D-mac-1 D-linux-1 | First run of the installed package on macOS and Linux | U1 | high | macos, linux | all | planned |
| INST-003 | D-mac-2 D-linux-1 | Quitting or killing the app leaves no host or runtime | U1 | medium | macos, linux | all | planned |
| UPD-002 | D-upg-2 | Update between release candidates keeps data, sign-ins and the runtime | U3 | high | windows | all | planned |
| UPD-003 | D-upg-3 | The install folder after an update is clean | U2 | medium | windows | all | planned |
| UPD-004 | N3 | The app ends for an update while a reply runs | U2 | high | all | en, ja | automated (release-playbook.mjs) |
| UPD-005 | P18 | Switching the update channel release → QA → release keeps data | U3 | medium | windows | all | planned |
| START-002 | P2 | Without a remembered session the folder's latest one opens | U9 | high | all | en, ja | automated (release-playbook.mjs) |
| SESS-001 | P3 P5 | Sending in an old session keeps it whole | U9 | high | all | en, ja | automated (release-playbook.mjs) |
| SESS-002 | P4 | An old session of another folder stays in its folder | U11 | high | all | en, ja | automated (release-playbook.mjs) |
| SESS-003 | P6 | A very large old session (20 MB or more) opens and answers | U9 | medium | all | en, ja | automated (release-playbook.mjs) |
| SESS-004 | P9 | Switching away and back shows the reply as it was live | U4 | high | all | en, ja | automated (release-playbook.mjs) |
| SESS-005 | P10 | A background session keeps its state in the list | U4 | medium | all | en, ja | automated (release-playbook.mjs) |
| SESS-006 | P15 | Thirty open sessions still work | U4 | medium | all | en, ja | automated (release-playbook.mjs) |
| SESS-007 | P16 | Reloading the window ten times and quitting leaves nothing behind | U4 | medium | all | en, ja | automated (release-playbook.mjs) |
| SIGN-001 | N4 | Sign in to Shisa.AI and sign out | U5 | high | all | en, ja | automated (release-playbook.mjs) |
| SIGN-002 | N4 C-mac-models | The model list follows sign-in and sign-out without a restart | U5 | high | all | all | gap: The runtime (jouzu 0.2.5) always fetches the Shisa.AI model list from the fixed api.shisa.ai address and does not use the model-list address the sign-in returns, so a stand-in cannot serve it, and a real account needs a person to approve the sign-in in a browser. |
| IMG-001 | P19 C-win-image | The image tool with a paid account and with ChatGPT | U10 | high | all | all | planned |
| IMG-002 | C-mac-image-free | The image tool with a free Shisa.AI account | U10 | medium | all | all | planned |

## regression (17)

| ID | Old | Title | Scenario | Priority | Platforms | Languages | Automation |
|---|---|---|---|---|---|---|---|
| REG-214 | #214 | A finished reply is not shown as Interrupted | U4 | medium | all | en, ja | automated (abnormal-playbook.mjs) |
| REG-177 | #177 #179 | Send while a new session's runtime starts | U4 | high | all | en, ja | automated (abnormal-playbook.mjs) |
| REG-178 | #178 | A provider server error is not called no network | U6 | medium | all | en, ja | automated (abnormal-playbook.mjs) |
| RT-006 | #87 | Retry after the runtime's files come back | U7 | high | all | en, ja | automated (abnormal-playbook.mjs) |
| SESS-008 | P17 #33 | A draft stays in its own session | U4 | medium | all | en | automated (abnormal-playbook.mjs) |
| REG-233 | #233 | Opening a saved session does not show it as Running | U9 | medium | all | en, ja | automated (abnormal-playbook.mjs) |
| REG-212 | #212 | A background session's live state shows in the list | U4 | medium | all | en, ja | automated (abnormal-playbook.mjs) |
| REG-162 | #162 | Waiting messages come back paused after a restart | U4 | high | all | en | automated (abnormal-playbook.mjs) |
| REG-174 | #174 | A session whose folder was deleted | U11 | medium | all | en, ja | automated (abnormal-playbook.mjs) |
| REG-119 | #119 | An image in a sent message stays after switching sessions | U4 | medium | all | en | automated (abnormal-playbook.mjs) |
| REG-173 | #173 | An environment change reaches the open session | U8 | high | all | en | automated (abnormal-playbook.mjs) |
| REG-171 | #171 | A custom connection can be removed | U8 | medium | all | en | automated (abnormal-playbook.mjs) |
| REG-205 | #205 #168 | Settings show no dirty build and no launcher | U8 | low | all | en, ja | automated (abnormal-playbook.mjs) |
| REG-208 | #208 | Commit marking can be switched on and kept | U8 | low | all | en | automated (abnormal-playbook.mjs) |
| REG-026 | #26 | Settings stay open when clicking beside them | U8 | low | all | en | automated (abnormal-playbook.mjs) |
| FOLD-001 | C-mac-239 #239 | A folder opened through a symlink is listed once | U11 | medium | macos, linux | all | planned |
| SEC-001 | #130 | The host token is in no file | U12 | high | all | en | automated (abnormal-playbook.mjs) |

## abnormal (27)

| ID | Old | Title | Scenario | Priority | Platforms | Languages | Automation |
|---|---|---|---|---|---|---|---|
| CHAT-015 |  | Nothing moves while a reply runs | U4 | medium | all | en | automated (abnormal-playbook.mjs) |
| CHAT-016 |  | Stop right after Send | U4 | medium | all | en | automated (abnormal-playbook.mjs) |
| CHAT-017 |  | Stop while the provider has not answered | U6 | high | all | en | automated (abnormal-playbook.mjs) |
| CHAT-018 |  | Stop while the reply is writing | U4 | high | all | en | automated (abnormal-playbook.mjs) |
| CHAT-019 |  | Stop while a new session's runtime is still starting | U7 | medium | all | en | automated (abnormal-playbook.mjs) |
| CHAT-020 |  | Stop with a message waiting in the queue | U4 | high | all | en | automated (abnormal-playbook.mjs) |
| INST-004 | D-mac-3 D-linux-1 | Runtime files deleted while the app runs are reinstalled | U7 | medium | macos, linux | all | planned |
| PROV-001 |  | Provider rejects the key while sending | U6 | high | all | all | automated (abnormal-playbook.mjs) |
| PROV-002 |  | Provider rate-limits the request | U6 | high | all | all | automated (abnormal-playbook.mjs) |
| PROV-003 |  | Provider fails with a server error | U6 | high | all | all | automated (abnormal-playbook.mjs) |
| PROV-004 |  | Provider unreachable (network down) | U6 | high | all | all | automated (abnormal-playbook.mjs) |
| PROV-005 |  | Model removed by the provider | U6 | medium | all | all | automated (abnormal-playbook.mjs) |
| PROV-006 |  | Reply cut off mid-stream | U6 | high | all | all | automated (abnormal-playbook.mjs) |
| PROV-007 |  | Provider slow to answer (8 s to first word) | U6 | medium | all | all | automated (abnormal-playbook.mjs) |
| RT-001 | P14 | Runtime killed while the session is idle | U7 | high | all | all | automated (abnormal-playbook.mjs) |
| RT-002 | P14 | Runtime killed while the reply is writing | U7 | high | all | all | automated (abnormal-playbook.mjs) |
| RT-003 |  | Runtime keeps crashing | U7 | high | all | en, ja | automated (abnormal-playbook.mjs) |
| RT-004 |  | Runtime slow to start, a new session is sendable at once | U7 | high | all | en | automated (abnormal-playbook.mjs) |
| RT-005 |  | Computer asleep for 30 s during a reply | U7 | medium | all | en | automated (abnormal-playbook.mjs) |
| SESS-009 |  | Old and damaged saved sessions | U9 | medium | all | en, ja | automated (abnormal-playbook.mjs) |
| SET-001 |  | Rapid settings changes | U8 | medium | all | en | automated (abnormal-playbook.mjs) |
| SET-002 |  | Settings file cannot be written | U8 | high | all | en, ja | automated (abnormal-playbook.mjs) |
| SET-003 |  | Missing tools.json | U8 | low | all | en | automated (abnormal-playbook.mjs) |
| INPUT-001 |  | Very long message (300 KB) | U4 | medium | all | en, ja | automated (abnormal-playbook.mjs) |
| INPUT-002 |  | Long unbroken token in a message | U4 | low | all | en | automated (abnormal-playbook.mjs) |
| INPUT-003 |  | Image the model refuses | U4 | medium | all | en, ja | automated (abnormal-playbook.mjs) |
| INPUT-004 |  | A file that is not an image, named .png | U4 | medium | all | en, ja | automated (abnormal-playbook.mjs) |

## Steps

### CHAT-001 A new session answers at once

A new session in this folder can be used at once.

| # | Do | Expect |
|---|---|---|
| 1 | Open a new session and send a message. | From the host taking the message to the reply's first output is under 2 s. |

Limit: message.accepted to message.first_output: fail above 2 s, target 0.5 s (set by product owner 2026-11-13)

### CHAT-002 A new session while another one is running

A new session can be opened while another reply runs; the running one is not affected and both rows show their state.

| # | Do | Expect |
|---|---|---|
| 1 | Start a long reply; open a new session and send there. | Both replies arrive; both rows show their state. |

### CHAT-003 Stop while a tool runs

Stop while a tool is running ends the turn safely, the tool shows as stopped (not running), nothing is shown as an error, and the next message is answered.

Data: A reply that runs a 30 s command (fixture TOOLWAIT).

| # | Do | Expect |
|---|---|---|
| 1 | Send a message whose reply runs a long command; wait until it shows as running. | The status names the running tool. |
| 2 | Press Stop. | Send comes back within 2 s; no problem is shown; the tool no longer shows as running. |
| 3 | Send the next message. | The reply arrives. |

Limit: Stop to Send back: 2 s (set by release playbook)

### CHAT-004 Switching the model

The model list shows only chat models, also before the first message; the next turn uses the chosen model and the model shown is the one used.

| # | Do | Expect |
|---|---|---|
| 1 | Open the model list in a new session. | Only chat models are listed. |
| 2 | Choose another model and send. | The provider is asked with that model; the composer shows it. |

### CHAT-005 A question or approval from the agent

When the agent asks a question or needs an approval, the app shows it and the reply continues after the answer.

Before: The saved tool settings (tools.json) ask for review of the read tool, as they do for the image tool by default.

| # | Do | Expect |
|---|---|---|
| 1 | With review switched on for the read tool, send a message whose reply reads a file. | The approval shows with its choices; the session's row says it waits. |
| 2 | Approve it. | The reply continues and ends. |
| 3 | Do the same again and Deny it. | The reply ends without running the tool; nothing shows as running; the next message is answered. |

### CHAT-006 A reply with many steps keeps every step on screen

In a reply of five or more steps (thinking, tool, thinking) each step's reasoning and tool stay on screen; after a reload and a restart it looks the same.

Data: Fixture STEPS:n reply.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message whose reply takes 6 steps. | Every step's thinking and tool stay on screen; none disappears after the second. |
| 2 | Reload, then restart the app. | The reply looks the same. |

### CHAT-007 The status line says what the reply is doing

While a reply runs, the status line says what is happening (waiting for the model and how long, thinking, writing, which tool and how long, which step); never a bare Working.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message whose reply thinks, runs a tool and writes. | Each phase is named on the status line. |

### CHAT-008 Automatic retry and context compaction are shown

A failed model request that is retried shows "request failed, retry a/b (reason)"; compaction shows as such; neither looks stuck.

Data: Fixture: one refused request ({status: 500, times: 1}); a BULK reply (older turns), then a FULL reply that reports 30,000 of the model's 32,000 tokens used.

| # | Do | Expect |
|---|---|---|
| 1 | Make the provider fail once, then answer. | The status shows the retry with its count and reason; the reply arrives. |
| 2 | Fill the context until it is compacted. | The status shows compaction. |

### CHAT-009 A tool stopped or cut off shows as interrupted

A tool stopped half-way, or cut off when the runtime ends, shows as interrupted or failed, never still running; the next turn works; in old sessions a tool without a result also shows as interrupted.

| # | Do | Expect |
|---|---|---|
| 1 | Stop while a tool runs; then end the runtime while another tool runs. | Both tools show as interrupted; none as running. |
| 2 | Open an old session with a tool call that has no result. | That tool shows as interrupted. |

### CHAT-010 Two messages sent while a reply runs are each used once

While a reply runs, two messages go to the queue above the composer and the button says Steer; the runtime takes them in order, each shows once in the conversation, the model is asked about each once, and the queue empties.

| # | Do | Expect |
|---|---|---|
| 1 | Start a long reply; send two messages. | Both wait in the queue in order, not yet in the conversation; the button says Steer. |
| 2 | Wait for the reply to end. | Each shows once in the conversation, in order; the provider was asked about each once; the queue is empty. |

### CHAT-011 Queued messages can be deleted, edited and kept on Stop

A deleted queued message is never sent; Edit puts its text and image back in the composer; after Stop the rest wait with Continue and Discard, Continue sends once, and Stop is not shown as an error.

| # | Do | Expect |
|---|---|---|
| 1 | Queue three messages during a long reply; delete one; edit one. | The deleted one is gone; the edited one is back in the composer. |
| 2 | Press Stop. | The rest wait with Continue and Discard; no error shows. |
| 3 | Press Continue. | Each waiting message is sent once; the deleted one never. |

### CHAT-012 TextGuard per session (on, strict, off)

The TextGuard mode is kept per session and never switched off by itself.

| # | Do | Expect |
|---|---|---|
| 1 | Set different modes in two sessions; switch and restart. | Each session keeps its own mode. |

### CHAT-013 A request held by Flow

The banner's actions on a held request work and nothing stays stuck.

| # | Do | Expect |
|---|---|---|
| 1 | Get a request held by Flow; use each banner action. | Each action works; the session is not stuck. |

### CHAT-014 Web access from this computer and another device

Through web access, opening old sessions and new sessions behave as SESS-001 and CHAT-001.

| # | Do | Expect |
|---|---|---|
| 1 | Open the app through web access, here and from another device. | Same as SESS-001 and CHAT-001. |

### CHAT-015 Nothing moves while a reply runs

The baseline for every layout check. Starting and ending a normal turn does not move the composer or resize the conversation.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message with a long reply and watch the layout. | The composer and conversation keep their place and size. |

### CHAT-016 Stop right after Send

Stop before anything is written ends the turn; nothing is left running or shown as failed.

Data: Provider slow to the first word.

| # | Do | Expect |
|---|---|---|
| 1 | Send and press Stop at once. | Send comes back; nothing shows as running or failed; the next message is answered. |

### CHAT-017 Stop while the provider has not answered

A provider that hangs must never trap the session. Stop gives Send back.

Data: Provider that never answers (fixture hang).

| # | Do | Expect |
|---|---|---|
| 1 | Send, then press Stop. | Send comes back; the next message is answered once the provider answers again. |

### CHAT-018 Stop while the reply is writing

Stop during output keeps what was written and gives Send back.

| # | Do | Expect |
|---|---|---|
| 1 | Press Stop while the reply is writing. | The written part stays; Send comes back; the next message is answered. |

### CHAT-019 Stop while a new session's runtime is still starting

Stop during a slow start leaves a usable session.

Data: Runtime start delayed 8 s.

| # | Do | Expect |
|---|---|---|
| 1 | Send in a new session while its runtime starts; press Stop. | The session is usable; the next message is answered. |

### CHAT-020 Stop with a message waiting in the queue

The waiting message is kept (Continue or Discard), never lost or sent twice.

| # | Do | Expect |
|---|---|---|
| 1 | Queue a message during a long reply; press Stop. | The message waits with Continue and Discard. |
| 2 | Press Continue. | It is sent once. |

### REG-214 A finished reply is not shown as Interrupted

After a normal turn the status line says how it ended, never "Interrupted".

| # | Do | Expect |
|---|---|---|
| 1 | Send a message and let the reply end. | The status line never says Interrupted. |

### REG-177 Send while a new session's runtime starts

On a slow start the message is sent at once, the session is listed at once, Stop is offered and Steer is not.

Data: Runtime start delayed 8 s.

| # | Do | Expect |
|---|---|---|
| 1 | Send in a new session while its runtime starts. | The message shows at once; the session is listed; Stop is offered, Steer is not; the reply arrives. |

### UI-001 Problems and notices are shown in their place

No floating notice or pop-up at the top; a session's notices appear in one place above the composer in one style (a sentence, an action, details); app-level errors stay in Settings, the folder list or their panel; no raw technical text on screen except under Details.

| # | Do | Expect |
|---|---|---|
| 1 | At the end of every case, look at the whole window. | No floating notice; no raw technical text as a main sentence. |

### INST-001 A new user's first run

A person who never used Jouzu opens it. The app prepares its runtime by itself, asks for the languages, offers Shisa.AI sign-in and another provider, and after a provider is saved a new session answers, with no restart and nothing for the person to fix.

Before: No runtime, model, settings or sessions. The machine is online.

Data: Custom provider = the fixture (OpenAI-compatible), model "deterministic".

| # | Do | Expect |
|---|---|---|
| 1 | Open the app. | The app prepares its runtime on its own. A failure says in plain words what failed. |
| 2 | Wait, and press Continue on the language page. | The language page comes first, then the model connection page, which offers Shisa.AI sign-in. |
| 3 | On the same page add a custom provider (address, model ID, key) and save. | The chat opens within 2 min, without a restart. |
| 4 | Open a new session and send a message. | The reply arrives within 30 s. The host started once. |

### INST-002 First run of the installed package on macOS and Linux

The DMG app, the AppImage and the .deb, started with a throwaway home, install their runtime on their own and answer a message.

Before: The package of this rc, a throwaway home.

| # | Do | Expect |
|---|---|---|
| 1 | Start the installed app with a throwaway home. | The start page becomes ready on its own. |
| 2 | Open a new session and send a message. | A reply arrives. |

### INST-003 Quitting or killing the app leaves no host or runtime

After Quit, and after the app process is killed, no host or runtime of that app is left running.

| # | Do | Expect |
|---|---|---|
| 1 | Quit the app (Cmd+Q, closing the window). | No host or runtime process is left. |
| 2 | Start it again and kill the app process. | Within 5 s no host or runtime process is left. |

### INST-004 Runtime files deleted while the app runs are reinstalled

The app notices its runtime files are gone, says it is reinstalling them, and a session answers afterwards.

| # | Do | Expect |
|---|---|---|
| 1 | With the app running, delete the runtime's files under its home. | Within 60 s the app shows that it is reinstalling the runtime. |
| 2 | Open a session and send a message. | A reply arrives. |

### UPD-001 Update from the last release keeps sessions, settings and sign-ins

A person on the last release updates in the app through the QA feed. After the update every session, setting and sign-in is still there and a message is answered.

Before: The last release installed and used (sessions, a changed setting, a sign-in). The real data and install folders of the test machine moved aside first and restored after.

Data: The real QA update feed (the feed is compiled into the app; there is no address switch).

| # | Do | Expect |
|---|---|---|
| 1 | Settings > check for updates. | The rc under test is offered. |
| 2 | Install it. | The app restarts on the new version by itself. |
| 3 | Open the sessions, Settings and the model list. | Sessions, the changed setting and the sign-in are all there. |
| 4 | Send a message in an old session. | A reply arrives. |

### UPD-002 Update between release candidates keeps data, sign-ins and the runtime

An update from the previous rc keeps data and sign-ins, keeps a runtime that is already the pinned version, and never stops on Preparing.

Before: The previous rc installed and used.

| # | Do | Expect |
|---|---|---|
| 1 | Update through the app. | The app restarts on the new version; it does not stop on Preparing. |
| 2 | Open sessions and Settings, send a message. | Data and sign-ins are kept; a reply arrives. |

### UPD-003 The install folder after an update is clean

After an update Settings > System shows the release commit (not dirty), and uninstalling keeps the data folder.

| # | Do | Expect |
|---|---|---|
| 1 | After UPD-001 or UPD-002, open Settings > System. | The commit has no "-dirty". |
| 2 | Uninstall silently. | The data folder is kept. |

### UPD-004 The app ends for an update while a reply runs

An update ends the app while a reply is running. When the app opens again the session is there, the interrupted message has an end the person can see, and the next message is answered.

Data: A reply that runs a 30 s command (fixture TOOLWAIT).

| # | Do | Expect |
|---|---|---|
| 1 | Send a message whose reply runs a long command; wait until the command shows as running. | The command shows as running. |
| 2 | End the app the way the Windows installer does (host and runtimes at once) and start it again on the same data. | Loading ends; the session is in the list with the interrupted message. |
| 3 | Look at the interrupted message. | It is not shown as running or waiting; it has a visible end (for example Interrupted). |
| 4 | Send the next message. | A reply arrives. |

### UPD-005 Switching the update channel release → QA → release keeps data

Moving from the release channel to the QA channel and back keeps every session and setting in both directions.

| # | Do | Expect |
|---|---|---|
| 1 | Switch to the QA channel and update. | Data is complete. |
| 2 | Switch back to the release channel and update. | Data is complete. |

### PROV-001 Provider rejects the key while sending

An expired or revoked key (401) says so on the reply, without stopping the session or showing raw provider text.

Data: Fixture answers 401.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message. | The reply says the key was refused, in plain words, once. |
| 2 | Fix the cause and send again. | The reply arrives. |

### PROV-002 Provider rate-limits the request

429 ends in a readable failure or a reply within the limit, not an endless retry the person cannot see.

Data: Fixture answers 429.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message. | A readable failure or a reply within the limit; no silent endless retry. |
| 2 | Fix the cause and send again. | The reply arrives. |

### PROV-003 Provider fails with a server error

A provider outage (500) shows on the reply; the person can try again.

Data: Fixture answers 500.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message. | The reply says the provider failed; a way to try again is offered. |
| 2 | Fix the cause and try again. | The reply arrives. |

### PROV-004 Provider unreachable (network down)

With no network or a gateway down, the reply says it could not reach the provider.

Data: Fixture resets the connection.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message. | The reply says the provider could not be reached. |
| 2 | Fix the cause and send again. | The reply arrives. |

### PROV-005 Model removed by the provider

A model the provider no longer offers (404) is named as such, once.

Data: Fixture answers 404 for the model.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message. | The reply says the model is no longer offered, once. |

### PROV-006 Reply cut off mid-stream

The provider drops the connection while writing. The written part stays, the reply is marked, the next message works.

Data: Fixture cuts the stream after 5 chunks.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message with a long reply. | The written part stays; the reply is marked as cut off. |
| 2 | Send the next message. | The reply arrives. |

### PROV-007 Provider slow to answer (8 s to first word)

A slow provider is not an error. The person's own message shows at once, the turn visibly works, the reply arrives, nothing is shown as failed.

Data: Fixture waits 8 s before the first word.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message. | The message shows at once; the turn shows it is working; the reply arrives; nothing shows as failed. |

### REG-178 A provider server error is not called no network

A 500 from the provider and an unreachable provider are told apart in the words the person reads.

| # | Do | Expect |
|---|---|---|
| 1 | Send once with the provider answering 500, once with it unreachable. | The two messages say different things; the 500 is not called no network. |

### RT-001 Runtime killed while the session is idle

A runtime that died between messages must not cost the next message.

| # | Do | Expect |
|---|---|---|
| 1 | After an answered message, end every runtime. | Nothing is shown as broken. |
| 2 | Send the next message. | The reply arrives. |

### RT-002 Runtime killed while the reply is writing

The interrupted reply is marked once; the session is usable again within 10 s; other sessions are not affected.

| # | Do | Expect |
|---|---|---|
| 1 | End every runtime while a reply is writing. | The reply is marked interrupted once; within 10 s the session is usable. |
| 2 | Send the next message. | The reply arrives. |

### RT-003 Runtime keeps crashing

A runtime that dies again and again ends in one readable session error with one way out, not an endless spinner; the way out works once the cause is gone.

| # | Do | Expect |
|---|---|---|
| 1 | Keep ending the runtime for 20 s and send a message. | One readable session error with one way out; no endless spinner. |
| 2 | Stop ending it and use the way out. | The session answers. |

### RT-004 Runtime slow to start, a new session is sendable at once

On a slow or busy computer the runtime may take seconds; the person can still type and send at once, and the message is answered when it is ready.

Data: Runtime start delayed 8 s.

| # | Do | Expect |
|---|---|---|
| 1 | Open a new session and send at once. | Typing and Send work at once; the reply arrives when the runtime is ready. |

### RT-005 Computer asleep for 30 s during a reply

After sleep the reply finishes or is marked once, nothing is duplicated, and the session works.

| # | Do | Expect |
|---|---|---|
| 1 | Freeze the app's processes for 30 s while a reply runs. | The reply finishes or is marked once; nothing is duplicated. |
| 2 | Send the next message. | The reply arrives. |

### RT-006 Retry after the runtime's files come back

The runtime's files are missing at start. The start page says so (not an endless Connecting), Retry says so again while they are missing, and once they are back Retry opens a session that answers.

Before: The runtime's files moved away before the app starts.

| # | Do | Expect |
|---|---|---|
| 1 | Start the app. | The start page says the runtime files are missing. |
| 2 | Press Retry. | It says so again. |
| 3 | Put the files back and press Retry. | A session opens and answers. |

### START-001 Cold start opens the last session

After the app is closed and opened again, loading ends on the session the person was in. Its history and title are there and a message can be sent at once.

Data: Fixture model (arithmetic questions with known answers).

| # | Do | Expect |
|---|---|---|
| 1 | Open a new session and send a message. | The reply arrives. |
| 2 | Close the app and open it again. | When loading ends the same session is shown with its history and title, within 30 s. |
| 3 | Send the next message at once. | The reply arrives within 30 s. |

### START-002 Without a remembered session the folder's latest one opens

When the window remembers only the folder, its most recent session opens with its whole history, tool results included.

Data: A reply that runs a tool (fixture TOOL).

| # | Do | Expect |
|---|---|---|
| 1 | Send a message whose reply uses a tool. | The tool result and the reply show. |
| 2 | Make the window forget the session (keep the folder) and start the app again. | The folder's latest session opens with its whole history, the tool result included. |

### SESS-001 Sending in an old session keeps it whole

Opening an old session of the same folder and sending keeps the history and title, writes the same file, adds no row; after a reload and a full restart it is still there.

| # | Do | Expect |
|---|---|---|
| 1 | Make a session with one answered message; restart the app; open another session. | Both are listed. |
| 2 | Click the old session. | Its history shows (proposed line 1 s, not decided; the case notes it). |
| 3 | Send a message. | The reply arrives; the earlier history stays; exactly that session's file grows; no new file with its messages; no new row; the title is unchanged. |
| 4 | Reload the window, then restart the app. | The old session is still listed both times. |

Limit: click to history: 1 s (set by proposed, not decided)

### SESS-002 An old session of another folder stays in its folder

Opening an old session that belongs to another folder and sending behaves as SESS-001, and the session stays in its own folder (the file header says which).

Before: A second folder added to the app.

| # | Do | Expect |
|---|---|---|
| 1 | Add a second folder; start a new session there with the folder picker; send a message. | The reply arrives; the session file's header names the second folder. |
| 2 | Restart the app; open a session of the first folder; then click the old session of the second folder. | Its history shows within 10 s. |
| 3 | Send a message. | The reply arrives; it is written to the same file; the header still names the second folder; no new file holds its messages; it is listed under the second folder, also after a reload. |

### SESS-003 A very large old session (20 MB or more) opens and answers

The history of a very large session is readable at once, sending does not freeze the window, and the status first says it is starting.

Before: A saved session of 20 MB or more (a generated one, never a person's real session).

| # | Do | Expect |
|---|---|---|
| 1 | Click the large session. | Its history is readable at once. |
| 2 | Send a message. | The window stays responsive; the status shows starting, then the reply arrives. |

Limit: click to history: 1 s regardless of file size (set by proposed, not decided)

Limit: window not answering while the session starts: none decided; recorded only (set by nobody decided)

### SESS-004 Switching away and back shows the reply as it was live

Switching to another session and back, while a reply runs and after it ended, shows the same tool calls and results as live, never "Unsupported content".

| # | Do | Expect |
|---|---|---|
| 1 | Start a reply with tool calls; switch to another session and back while it runs. | The tool calls and results match what was shown live. |
| 2 | Switch away and back after it ended. | The same; no "Unsupported content". |

### SESS-005 A background session keeps its state in the list

A session nobody is looking at keeps its state up to date in the list and is complete when opened again.

| # | Do | Expect |
|---|---|---|
| 1 | Start a reply and open another session. | The first session's row shows it is running, then finished. |
| 2 | Open the first session again. | The whole reply is there. |

### SESS-006 Thirty open sessions still work

With 30 sessions open, switching, sending and states still work (the lower bound for regressions).

| # | Do | Expect |
|---|---|---|
| 1 | Open 30 sessions, each with one message. | All listed with their states. |
| 2 | Switch between them and send in several. | Switching and replies work. |

### SESS-007 Reloading the window ten times and quitting leaves nothing behind

After ten window reloads and quitting, no runtime is left and handle counts are back at the start.

| # | Do | Expect |
|---|---|---|
| 1 | Reload the window ten times. | The app works after each. |
| 2 | Quit. | No runtime process is left; handles back at the baseline. |

Limit: processes left 15 s after quitting: none (set by release playbook P16)

Limit: host handles after ten reloads: none decided; recorded only (set by nobody decided)

### SESS-008 A draft stays in its own session

Text typed but not sent in one session never shows in another session's composer.

| # | Do | Expect |
|---|---|---|
| 1 | Type a draft in one session without sending; open another session. | The other composer is empty. |
| 2 | Go back. | The draft is there. |

### SESS-009 Old and damaged saved sessions

Sessions written by earlier versions, half-written or empty, are listed without breaking the list; opening one shows its history or one plain reason, never a spinner; a new session still works.

Before: The world's saved sessions in an older format, cut off mid-line, with an unknown entry, empty, and one whose folder was deleted.

| # | Do | Expect |
|---|---|---|
| 1 | Open each damaged session. | Its history or one plain reason shows; no spinner stays. |
| 2 | Open a new session and send. | The reply arrives. |

### REG-233 Opening a saved session does not show it as Running

Opening a saved session only starts its runtime; the list must not say it is running a reply.

| # | Do | Expect |
|---|---|---|
| 1 | Click a saved session. | Its row never shows Running. |

### REG-212 A background session's live state shows in the list

A session writing a reply while another is open shows as running; once done it shows as finished until opened; a stopped reply shows as a session at rest.

| # | Do | Expect |
|---|---|---|
| 1 | Start a long reply and open a new session. | The first row shows running, then finished. |
| 2 | Start another reply, stop it, open a new session. | That row shows a session at rest. |

### REG-162 Waiting messages come back paused after a restart

A message waiting in the queue is kept across a restart of the app, paused, with Continue and Discard; Continue sends it once.

Data: A provider that does not answer (fixture hang).

| # | Do | Expect |
|---|---|---|
| 1 | Send a message to a provider that hangs; queue a second message. | The second waits in the queue. |
| 2 | Restart the app. | The waiting message is back, paused, with Continue and Discard. |
| 3 | Press Continue. | It is sent once. |

### REG-174 A session whose folder was deleted

It stays in the list and in its folder group, says its folder is gone, offers no Restart session and starts no runtime.

Before: A saved session whose folder no longer exists.

| # | Do | Expect |
|---|---|---|
| 1 | Click it. | It says its folder is gone; no Restart session; no runtime starts. |

### REG-119 An image in a sent message stays after switching sessions

The image a person sent is still shown in the message after opening another session and coming back.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message with an image; open another session; come back. | The image still shows in the message. |

### SET-001 Rapid settings changes

Changing a setting many times quickly never fails with "another operation is running", ends on the last choice and survives a reload.

| # | Do | Expect |
|---|---|---|
| 1 | Change the interface language many times in a row. | No "another operation is running"; the last choice is shown. |
| 2 | Reload. | The last choice is kept. |

### SET-002 Settings file cannot be written

When a setting cannot be saved, that card says so in plain words, nothing moves, and nothing else stops working.

Before: settings.json made read-only for this user (the case runs as a normal user).

| # | Do | Expect |
|---|---|---|
| 1 | Change a setting that is saved in settings.json. | The card says it was not saved, in plain words; nothing moves. |
| 2 | Make the file writable again; send a message. | The reply arrives. |

### SET-003 Missing tools.json

A data folder without tools settings opens the Tools page normally.

Before: data/agent/tools.json removed.

| # | Do | Expect |
|---|---|---|
| 1 | Open Settings > Tools. | The page shows normally. |

### REG-173 An environment change reaches the open session

A variable changed in Settings > Environment is used by the session already open, without restarting the app.

Data: The fixture requires a new key; the provider's key comes from an environment variable.

| # | Do | Expect |
|---|---|---|
| 1 | Send with the old key. | The key is refused. |
| 2 | Set the new key in Settings > Environment and save. | Saved, no error. |
| 3 | Send again in the same session. | The reply arrives without restarting the app. |

### REG-171 A custom connection can be removed

Remove connection deletes the provider and its key; it leaves the list at once.

| # | Do | Expect |
|---|---|---|
| 1 | Settings > Model providers > the extra connection > Remove connection. | It leaves the list at once and stays gone after reopening Settings. |

### REG-205 Settings show no dirty build and no launcher

Settings > System shows a clean build, and no page of Settings speaks of a launcher.

| # | Do | Expect |
|---|---|---|
| 1 | Open every Settings page. | System shows no "-dirty"; no page says launcher. |

### REG-208 Commit marking can be switched on and kept

In Settings > Collaboration the switch turns commit marking on, the author choice shows and is kept after reopening, and it turns off again.

| # | Do | Expect |
|---|---|---|
| 1 | Turn commit marking on and choose an author. | The choice shows. |
| 2 | Reopen Settings. | It is kept. |
| 3 | Turn it off. | It is off after reopening. |

### REG-026 Settings stay open when clicking beside them

A click outside the Settings window does not close it and lose what was being edited.

| # | Do | Expect |
|---|---|---|
| 1 | Open Settings and click beside the window. | Settings stay open. |

### FOLD-001 A folder opened through a symlink is listed once

Opening a folder by its real path and through a symlink lists it once.

| # | Do | Expect |
|---|---|---|
| 1 | Open a folder by its real path, then through a symlink to it. | The sidebar lists it once. |

### INPUT-001 Very long message (300 KB)

A huge paste is either sent whole or refused before sending with the text kept; the window does not widen or freeze.

| # | Do | Expect |
|---|---|---|
| 1 | Paste 300 KB of text and send. | Sent whole, or refused before sending with the text kept; the window keeps its width and responds. |

### INPUT-002 Long unbroken token in a message

A pasted path or id thousands of characters long never widens the window or moves the composer.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message with a 3,000-character unbroken token. | The window keeps its width; the composer does not move. |

### INPUT-003 Image the model refuses

A refused image shows once on the reply with a way out; the session does not stay stuck.

Data: Fixture refuses images.

| # | Do | Expect |
|---|---|---|
| 1 | Send a message with an image. | The refusal shows once on the reply, with a way out. |
| 2 | Send the next message. | The reply arrives. |

### INPUT-004 A file that is not an image, named .png

A broken attachment is refused at the composer with the text kept, never sent half-way.

| # | Do | Expect |
|---|---|---|
| 1 | Attach a non-image file named .png and send. | It is refused at the composer; the text is kept; nothing is sent. |

### SIGN-001 Sign in to Shisa.AI and sign out

In Settings the person signs in to Shisa.AI. The app shows the sign-in address and the device code, says it is connected once the device is approved, with no restart. Signing out asks Shisa.AI to revoke the device and the app shows the signed-out state again. Nothing is shown as an error.

Before: Shisa.AI sign-in goes to a local stand-in through the runtime's address setting (JOUZU_SHISA_PLATFORM_URL); the stand-in approves on its second poll.

| # | Do | Expect |
|---|---|---|
| 1 | Settings > Model providers > Sign in to Shisa.AI. | The sign-in address (platform.shisa.ai/connect) and the device code Shisa.AI gave are shown. |
| 2 | Wait for the approval. | Within 30 s the app says it is connected; the link is confirmed to Shisa.AI; no problem is shown. |
| 3 | Sign out. | Within 30 s the signed-out state is back; Shisa.AI was asked to revoke the device; no problem is shown. |
| 4 | Send a message with the fixture model. | The reply arrives. |

### SIGN-002 The model list follows sign-in and sign-out without a restart

After sign-in the New session model list has the account's models without a restart; after sign-out they are gone.

| # | Do | Expect |
|---|---|---|
| 1 | Note the model list; sign in. | The account's models are listed, without a restart. |
| 2 | Sign out. | Those models are gone. |

### IMG-001 The image tool with a paid account and with ChatGPT

With a valid key the image tool makes an image in each language and with each provider; otherwise it gives a clear message.

Before: A dedicated QA test account for the Shisa.AI image service (decided by the product owner 2026-11-27); its key in a secret store, never in the repository.

| # | Do | Expect |
|---|---|---|
| 1 | Ask for an image in en and in ja. | An image is made each time. |
| 2 | Choose the other provider and ask again. | An image is made. |
| 3 | Use a key that is not valid. | A clear message says what is wrong. |

### IMG-002 The image tool with a free Shisa.AI account

With a free account, Settings > Tools shows Shisa.AI as the provider and says the plan has no image generation; asking for an image gives that message, not an error.

Before: A dedicated free QA test account.

| # | Do | Expect |
|---|---|---|
| 1 | Open Settings > Tools. | Shisa.AI is the provider and the plan's limit is said. |
| 2 | Ask for an image. | A clear message about the plan. |

### SEC-001 The host token is in no file

The host gives its API token only to the app that started it; the agent's tools cannot read it from a file.

| # | Do | Expect |
|---|---|---|
| 1 | Search the app's home for the host token. | No file holds it. |

