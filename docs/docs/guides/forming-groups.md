---
id: forming-groups
title: Forming groups
sidebar_label: Forming groups
description: How participants end up in groups, how to hold them in a waiting room until their group is complete, and what changes once it is.
---

# Forming groups

A multiplayer experiment needs participants in groups before it can start. There are two ways
to get them there:

- **One link per group.** You decide who plays together by giving each group its own link.
  Everyone who opens the same link is in the same group. This suits sessions you schedule, such
  as a lab session where you know who is coming.
- **One link for everyone.** All participants open the same link, and the backend fills groups
  as they arrive: the first arrivals form the first group, and when it is full, the next
  arrivals start another. This suits online recruitment, where participants arrive one at a
  time and you can't tell in advance who will be there.

Which one you get depends on the adapter:

| Adapter | How groups form |
| --- | --- |
| [`adapter-multiplayer-local`](../reference/adapter-multiplayer-local) | One link per group (`?mp_session=`). |
| [`adapter-multiplayer-firebase`](../reference/adapter-multiplayer-firebase) | One link per group by default; one link for everyone with the `matchmaking` option. |
| [`adapter-multiplayer-jatos`](../reference/adapter-multiplayer-jatos) | One link for everyone. JATOS fills groups up to the batch's **Max active members**. |

The rest of this page is about the second way.

## Forming, then sealed

A group is **forming** while it still has room. It becomes **sealed** once nobody new can
join, which happens when its last place is taken. The difference matters when someone leaves:

- **While the group is forming**, a participant who closes the tab gives up their place, and the
  next person to arrive takes it. Nobody in the group has started yet, so nothing is lost.
- **Once the group is sealed**, its members are final. A member who leaves counts as a
  [dropout](handling-dropouts), and nobody replaces them.

`jsPsych.multiplayer.group()` reports where the group stands:

```js
const { size, members, sealed } = jsPsych.multiplayer.group();
// size: how many the group holds, e.g. 2
// members: the participant IDs in the group so far, including this one
// sealed: true once the group is complete
```

## The waiting room

`connect()` finishes as soon as a participant has a place in a group, which is usually before
the group is full. So start the experiment with a waiting room that holds each participant until
their group is sealed. `jsPsych.multiplayer.waitForGroup()` does the waiting:

```js
const waitingRoom = {
  type: jsPsychCallFunction,
  async: true,
  func: (done) => {
    jsPsych.getDisplayElement().innerHTML = "<p>Waiting for the other players to arrive...</p>";
    jsPsych.multiplayer
      .waitForGroup({ timeout: 5 * 60000 })
      .then((group) => done({ group_members: group.members }))
      .catch(() => jsPsych.abortExperiment("<p>Not enough players arrived. Thank you for waiting.</p>"));
  },
};

await jsPsych.run([waitingRoom, ...theExperiment]);
```

Always give the wait a `timeout`. When recruitment slows down, the last group may never fill,
and its members shouldn't wait forever. With a recruitment service, end their session in a way
that still pays them for their time.

### Starting with fewer players

Sometimes a smaller group is better than sending everyone home. `jsPsych.multiplayer.sealGroup()`
seals the group with the members it has now, and the waiting room then ends for all of them:

```js
func: async (done) => {
  jsPsych.getDisplayElement().innerHTML = "<p>Waiting for the other players to arrive...</p>";
  try {
    const group = await jsPsych.multiplayer.waitForGroup({ timeout: 5 * 60000 });
    done({ group_members: group.members });
  } catch (error) {
    if (error.name !== "MultiplayerTimeoutError") throw error;
    const presence = jsPsych.multiplayer.presence();
    const here = Object.values(presence).filter((status) => status === "connected").length;
    if (here < 3) {
      jsPsych.abortExperiment("<p>Not enough players arrived. Thank you for waiting.</p>");
      return;
    }
    await jsPsych.multiplayer.sealGroup();
    done({ group_members: jsPsych.multiplayer.group().members });
  }
},
```

Each participant's timeout starts when they arrive, so the first to arrive is the first to time
out. When that participant seals the group, everyone else's `waitForGroup()` ends at once.

## After the group is sealed

Once the group is sealed, the plugins know who is in it, so you don't need to count players
yourself:

- **Counts default to the group.** Leave `expected_players` (ready, choice, match) or
  `group_size` (role, scoreboard) as `null`, and the trial waits for the sealed group's members
  who haven't left.
- **Dropouts are caught.** With `participants: null`, a trial waits on the group's other
  members, including one who is only briefly `away`. If one of them leaves, the trial ends with
  `partner_left: true`, as described in [Handling dropouts](handling-dropouts).

For example, after the waiting room, a ready gate needs no count:

```js
const ready = {
  type: jsPsychMultiplayerReady,
  stimulus: "<p>Everyone is here. Click when you're ready to start.</p>",
};
```

Before the group is sealed, or with one link per group, these defaults aren't available: set the
counts yourself, and gather the group with a lobby first. The
[ultimatum game guide](ultimatum-game) shows that approach.

## Shared randomness

Each group gets its own session ID, so each group gets its own
[shared random values](../reference/multiplayer-api#shared-randomness): the same for everyone in
the group, and different from other groups.
