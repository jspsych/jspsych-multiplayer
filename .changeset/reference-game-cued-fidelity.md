---
"@jspsych-multiplayer/plugin-multiplayer-reference-game": minor
---

Add two options needed to match the original tangrams experiment (hawkrobe/tangrams) exactly:

- `scramble_mode: "disjoint"` — like `"independent"`, but guarantees no object occupies the same
  slot for both players. Plain `"independent"` only guarantees the two layouts are not identical, so
  around a third of objects still coincide by chance and positional reference ("the one in the
  corner") sometimes works by luck. The original re-rolls its layouts until every position differs.
- `feedback_content` may now be keyed by role — `{ director: {...}, matcher: {...} }` — so the two
  players can see different feedback. The original shows the director only the object the matcher
  clicked, and the matcher only the true target. A flat object still applies to both roles.
