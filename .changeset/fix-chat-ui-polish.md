---
"@jspsych-multiplayer/plugin-multiplayer-chat": patch
---

Fix unreadable chat transcript: the plugin shipped no CSS, so sender and message text rendered as bare unstyled `<span>`s with nothing between them (e.g. "AliceHello"). Inject minimal scoped styles (boxed log, one message per line, bold sender label with a colon separator, own-message highlight) so the transcript is legible out of the box.

Also clarifies the chat-room example's name prompt ("Choose a display name — this is what other participants will see you as in the chat") since testers read the original wording as naming the chat room itself.
