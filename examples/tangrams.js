// =================================================================================================
// Canonical tangram stimuli + faithful round schedules, shared by the two reference-game replications
// (reference-game-hawkins.html and reference-game-cwg.html).
//
// The 12 tangrams are the EXACT set from Hawkins, Frank & Goodman (2020), "Characterizing the Dynamics
// of Learning in Repeated Reference Games" (github.com/hawkrobe/tangrams, tangram_A…L.png), which are
// themselves reproduced from Clark & Wilkes-Gibbs (1986). Using this one set keeps both replications
// directly comparable to both papers. The shapes are intentionally UNNAMED (ids A–L only): coining a
// name for each hard-to-describe shape is the whole point of the task.
// =================================================================================================
(function (global) {
  const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

  // Plugin stimulus objects: { id, src }. `src` is relative to the examples/ dir (works when served).
  const STIMULI = LETTERS.map((L) => ({ id: L, src: `assets/tangrams/tangram_${L}.png` }));

  // Small seeded PRNG (mulberry32). A schedule must be RANDOM-LOOKING yet DETERMINISTIC so that both
  // tabs/partners, loading the same seed, agree on the target sequence — and so the paper gets a
  // reproducible order. For a real multi-dyad study, derive the seed from the shared session id so
  // each dyad differs while its two partners still agree (see the notes in each example).
  function mulberry32(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Hawkins "sequential" schedule: `blocks` repetition blocks × 12 trials (72 total at blocks=6). Each
  // tangram is the SINGLE target exactly once per block; the within-block order is reshuffled each
  // block. Returns blocks*12 rounds of { round, targets: [id] } with unique, contiguous round indices.
  function sequentialSchedule(blocks, seed) {
    const rng = mulberry32(seed || "hawkins-sequential");
    const ids = STIMULI.map((s) => s.id);
    const rounds = [];
    let r = 0;
    for (let b = 0; b < blocks; b++) {
      for (const id of shuffled(ids, rng)) rounds.push({ round: r++, targets: [id] });
    }
    return rounds;
  }

  // Clark & Wilkes-Gibbs "full-board" schedule: `trials` trials (6 in the original), each a fresh
  // random ORDER of all 12 tangrams that the matcher must reproduce. Returns `trials` rounds of
  // { round, targets: [all 12 ids, ordered] }.
  function fullBoardSchedule(trials, seed) {
    const rng = mulberry32(seed || "cwg-fullboard");
    const ids = STIMULI.map((s) => s.id);
    const rounds = [];
    for (let r = 0; r < trials; r++) rounds.push({ round: r, targets: shuffled(ids, rng) });
    return rounds;
  }

  global.Tangrams = { STIMULI, sequentialSchedule, fullBoardSchedule };
})(typeof globalThis !== "undefined" ? globalThis : this);
