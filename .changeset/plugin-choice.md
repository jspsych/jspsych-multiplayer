---
"@jspsych-multiplayer/plugin-multiplayer-choice": minor
---

Add `plugin-multiplayer-choice`: a simultaneous group-decision primitive. Each participant picks one of the same options; the trial pushes that choice and waits (a barrier) until all `expected_players` have chosen, then optionally reveals everyone's choices. It is the engine under simultaneous-move paradigms (prisoner's dilemma, public-goods contributions, dictator/coordination games), packaging the choose → push → wait → reveal flow as one declarative trial. Includes a `timeout` that degrades to a partial group, an optional `payoff(choices, me)` hook (off by default, so the plugin stays a pure decision primitive), `player_label`/`button_html` display hooks, and static access to the pure core (`collectChoices`/`countChosen`).
