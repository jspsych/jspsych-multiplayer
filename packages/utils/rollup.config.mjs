import { makeRollupConfig } from "@jspsych/config/rollup";

// A library of named helpers rather than a plugin with one default export
export default makeRollupConfig("jsPsychMultiplayerUtils").map((config) => ({
  ...config,
  output: [config.output]
    .flat()
    .map((output) => (output.exports === "default" ? { ...output, exports: "named" } : output)),
}));
