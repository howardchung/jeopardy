const jData = require('../jeopardy.json');

// Do a game/ep count
let counts = {};
let clueCount = 0;
let epCount = 0;
Object.values(jData).forEach((ep) => {
  if (!counts[ep.info]) {
    counts[ep.info] = 0;
  }
  counts[ep.info] += 1;
  epCount += 1;
  clueCount += ep.jeopardy.length + ep.double.length + ep.final.length;
});
console.log(counts);
console.log('%s eps, %s clues', epCount, clueCount);
