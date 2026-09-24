---
"@jspsych-multiplayer/plugin-multiplayer-reference-game": minor
---

Add a `typing_indicator` option (off by default) showing a "partner is typing…" hint driven by a
timestamp each client keeps in its own slot (`typing_key`, throttled by `typing_throttle`, hidden
`typing_ttl` after the last keystroke, labelled via `typing_label`). Hint only — it never gates
trial progress, and it hides while the partner is away or has left. The timestamp is written with
`update()`, which merges only that key, so it can't overwrite chat or round data.
