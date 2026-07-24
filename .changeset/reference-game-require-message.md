---
"@jspsych-multiplayer/plugin-multiplayer-reference-game": minor
---

Add a `require_message_before_response` parameter. When true, the matcher cannot commit a selection until the director has sent at least one chat message this round — while gated, matcher grid clicks are ignored and a brief hint is shown. This makes the plugin faithful to Hawkins, Frank & Goodman (2020) Exp. 2, whose client blocked the matcher's click behind `messageSent`, guaranteeing a referring expression on every trial. Defaults to `false` (unchanged behavior); inert with a warning when `chat_enabled` is false (gating with no channel would deadlock the matcher). Applies to both the `click` and `assign_slots` response modes.
