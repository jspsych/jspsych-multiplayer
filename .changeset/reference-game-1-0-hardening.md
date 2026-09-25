---
"@jspsych-multiplayer/plugin-multiplayer-reference-game": minor
---

Port reference-game to the hardened multiplayer API.

- Each round's shared data (the submission, the chat, typing timestamps) lives in the round's own trial scope. **Removed `data_key` and `typing_key`.** With `chat_persists`, the chat log is kept in the session scope. The stale-replay guard now catches rounds that share a `multiplayer_scope`.
- New data field `multiplayer_outcome` (`"completed"`, `"timeout"`, `"participant_left"`, `"connection_lost"`, or `"cancelled"`). **Removed `ended_by`, `partner_left`, and `connection_lost`.**
- `show_running_score` sums `n_correct` from this participant's earlier reference-game trials in the jsPsych data, plus the current round.
- Partner auto-detection uses the sealed group's other member, or else the other connected participant.
- `save_group` saves this round's shared data. Chat messages from a partner who leaves stay in the transcript.
- Uses `@jspsych-multiplayer/utils`. The send-error note is gone: the core retries failed writes.
