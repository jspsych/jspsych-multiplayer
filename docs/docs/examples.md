---
id: examples
title: Examples
sidebar_label: Examples
description: Complete multiplayer experiments, each in one HTML file, that you can run in two browser tabs and copy from.
---

# Examples

Each example is a complete experiment in one HTML file, in the
[`examples/`](https://github.com/jspsych/jspsych-multiplayer/tree/main/examples) folder of
the repository. Most use the local adapter, so you can play every part yourself from two or
more tabs of one browser.

## Running an example

From a clone of the repository (see
[Before the release](getting-started#before-the-release)):

```sh
npm install && npm run build
npx http-server .
```

Open an example, for example `http://localhost:8080/examples/chat-room.html`. Then copy the
**whole** address, including the `?mp_session=…` the page added to it, into a second tab. Each
tab is one participant.

To run an example with real participants on separate computers, change its adapter; see
[Choosing a backend](guides/choosing-a-backend).

## Economic games

| Example | What happens | Plugins |
| --- | --- | --- |
| [Ultimatum game](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/ultimatum-game-local.html) | One player offers a split of $10; the other accepts or rejects it. Walked through step by step in the [ultimatum game guide](guides/ultimatum-game). | [sync](reference/plugin-multiplayer-sync), [role](reference/plugin-multiplayer-role) |
| [Ultimatum game on JATOS](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/ultimatum-game-jatos.html) | The same game on a JATOS server. Only the backend differs. | sync, role |
| [Ultimatum game on Firebase](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/ultimatum-game-firebase.html) | The same game on Firebase, across devices. Only the backend differs. | sync, role |
| [Prisoner's dilemma](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/choice-room.html) | Two players choose Cooperate or Defect at the same time, then see both choices and their payoffs. | [choice](reference/plugin-multiplayer-choice), sync |
| [Pair up, then play](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/match-room.html) | A larger group is split into pairs, and each pair plays one round of the prisoner's dilemma. | [match](reference/plugin-multiplayer-match), choice, sync |
| [Public goods game](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/public-goods-local.html) | Players decide how much of an endowment to put into a shared pool, before a shared deadline. | sync, [countdown](reference/plugin-multiplayer-countdown) |

## Communication

| Example | What happens | Plugins |
| --- | --- | --- |
| [Chat room](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/chat-room.html) | Participants choose a display name, wait in a lobby, then chat for a fixed time. | [chat](reference/plugin-multiplayer-chat), sync |
| [Drawing together](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/draw-room.html) | Participants draw on one shared canvas for a timed round. | [draw](reference/plugin-multiplayer-draw), countdown, sync |
| [Reference game](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/reference-game.html) | A director describes one abstract shape at a time over chat, and a matcher picks it out (Hawkins, Frank & Goodman, 2020). | [reference-game](reference/plugin-multiplayer-reference-game), role, sync |
| [Reference game, full board](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/reference-game-match.html) | The same plugin, set up so the matcher puts every shape in the director's order. | reference-game, role, sync |

## Groups, votes and scores

| Example | What happens | Plugins |
| --- | --- | --- |
| [Poll](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/poll-room.html) | Everyone votes, then sees only the vote counts, not who voted for what. | choice, sync |
| [Countdown](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/countdown-timer.html) | A timer that ends at the same moment on every screen. | countdown, sync |
| [Scoreboard](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/scoreboard-room.html) | Each player answers a short quiz, then everyone sees the final ranking at once. | [scoreboard](reference/plugin-multiplayer-scoreboard), sync |
| [Live scoreboard](https://github.com/jspsych/jspsych-multiplayer/blob/main/examples/live-scoreboard-room.html) | The same quiz, with a ranking that updates as each player's score comes in. | scoreboard, sync |
| [Group quiz](https://github.com/jspsych/jspsych-multiplayer/tree/main/examples/group-quiz) | A classroom quiz game: one host screen runs the questions, and players answer on their phones against the clock. Runs on JATOS. | sync |

## References

Hawkins, R. D., Frank, M. C., & Goodman, N. D. (2020). Characterizing the dynamics of learning
in repeated reference games. _Cognitive Science_, 44(6), e12845.
