import { JsPsych, JsPsychPlugin, TrialType } from "jspsych";

import { version } from "../package.json";
import { assignRoles } from "./roles";
import { getMyAssignment, getMyRole, getRoleMap, participantsByRole } from "./store";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`). The runtime helpers (the pure core + the role accessors)
// are exposed as statics on the plugin class below, so everything is reachable through that one
// default export without deviating from the convention.
export type { Snapshot, RoleAssignment, RoleMap, Ctx, AssignOptions } from "./roles";

const info = <const>{
  name: "plugin-multiplayer-role",
  version: version,
  // The parameter and data schema is specified in the README and lands with the trial wrapper, which
  // depends on the jsPsych multiplayer API (jsPsych#3694). Kept empty until then rather than carrying
  // placeholder fields that would misrepresent the plugin's surface.
  parameters: {},
  data: {},
  // When you run build on your plugin, citations will be generated here based on the CITATION.cff.
  citations: "__CITATIONS__",
};

type Info = typeof info;

/**
 * **plugin-multiplayer-role**
 *
 * Assigns each participant in a multiplayer group a role by deterministic consensus — every client
 * independently computes the same role map from the shared group-session snapshot.
 *
 * The pure assignment core and the role accessors are reachable now as static members of this class
 * (`MultiplayerRolePlugin.assignRoles`, `.getMyRole`, `.getMyAssignment`, `.getRoleMap`,
 * `.participantsByRole`). The trial wrapper — the instance `trial()` — depends on the jsPsych
 * multiplayer API (https://github.com/jspsych/jsPsych/pull/3694) and is not implemented yet: running
 * it throws until that API lands. See the README for the committed parameter/data design.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-role}
 */
class MultiplayerRolePlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent assignment core. Usable standalone, today. */
  static assignRoles = assignRoles;

  // Role accessors for downstream trials. These read the store the trial wrapper populates, so they
  // return undefined/empty until an assignment has run (i.e. until the wrapper lands and executes).
  static getMyRole = getMyRole;
  static getMyAssignment = getMyAssignment;
  static getRoleMap = getRoleMap;
  static participantsByRole = participantsByRole;

  constructor(private jsPsych: JsPsych) {}

  trial(_display_element: HTMLElement, _trial: TrialType<Info>) {
    throw new Error(
      "plugin-multiplayer-role: the trial wrapper is not implemented yet — it depends on the jsPsych " +
        "multiplayer API (https://github.com/jspsych/jsPsych/pull/3694). The pure assignment core " +
        "(MultiplayerRolePlugin.assignRoles) and the role accessors (MultiplayerRolePlugin.getMyRole, " +
        ".getRoleMap, .participantsByRole) are available now."
    );
  }
}

export default MultiplayerRolePlugin;
