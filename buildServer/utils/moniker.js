"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeUserName = exports.makeRoomName = void 0;
const fs_1 = __importDefault(require("fs"));
let adjectives = fs_1.default
    .readFileSync(process.env.PWD + '/words/adjectives.txt')
    .toString()
    .split('\n');
const nouns = fs_1.default
    .readFileSync(process.env.PWD + '/words/nouns.txt')
    .toString()
    .split('\n');
const verbs = fs_1.default
    .readFileSync(process.env.PWD + '/words/verbs.txt')
    .toString()
    .split('\n');
const randomElement = (array) => array[Math.floor(Math.random() * array.length)];
function makeRoomName() {
    let filteredAdjectives = adjectives;
    const adjective = randomElement(filteredAdjectives);
    const noun = randomElement(nouns);
    const verb = randomElement(verbs);
    return `${adjective}-${noun}-${verb}`;
}
exports.makeRoomName = makeRoomName;
function makeUserName() {
    return `${capFirst(randomElement(adjectives))} ${capFirst(randomElement(nouns))}`;
}
exports.makeUserName = makeUserName;
function capFirst(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}
