import fs from 'fs';

let adjectives = fs
  .readFileSync(process.env.PWD + '/words/adjectives.txt')
  .toString()
  .split('\n');
const nouns = fs
  .readFileSync(process.env.PWD + '/words/nouns.txt')
  .toString()
  .split('\n');
const verbs = fs
  .readFileSync(process.env.PWD + '/words/verbs.txt')
  .toString()
  .split('\n');
const randomElement = (array: string[]) =>
  array[Math.floor(Math.random() * array.length)];

export function makeRoomName() {
  let filteredAdjectives = adjectives;
  const adjective = randomElement(filteredAdjectives);
  const noun = randomElement(nouns);
  const verb = randomElement(verbs);
  return `${adjective}-${noun}-${verb}`;
}

export function makeUserName() {
  return `${capFirst(randomElement(adjectives))} ${capFirst(
    randomElement(nouns),
  )}`;
}

function capFirst(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
