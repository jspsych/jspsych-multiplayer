import { JsPsych } from "jspsych";

/** jsPsych's multiplayer module: `jsPsych.multiplayer`. */
export type Multiplayer = JsPsych["multiplayer"];

/**
 * Return `jsPsych.multiplayer`, or throw a clear error on a jsPsych build that
 * doesn't have the multiplayer API.
 */
export function getMultiplayer(jsPsych: JsPsych): Multiplayer {
  const multiplayer = (jsPsych as Partial<Pick<JsPsych, "multiplayer">>).multiplayer;
  if (!multiplayer) {
    throw new Error(
      "multiplayer-countdown: this plugin needs a version of jsPsych with the multiplayer API " +
        "(jsPsych.multiplayer). See https://multiplayer.jspsych.org.",
    );
  }
  return multiplayer;
}
