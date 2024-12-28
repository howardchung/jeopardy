# Jeopardy

A website for playing Jeopardy! together with friends over the Internet. Designed for computer browsers, although it's playable on mobile. If the UI/code looks familiar, much of it is copied from my other project, WatchParty: https://github.com/howardchung/watchparty

## Description

- Implements the game show Jeopardy!, including the Jeopardy, Double Jeopardy, and Final Jeopardy rounds. Daily Doubles are also included.
- Any archived episode of Jeopardy! can be loaded, with options for loading specific event games (e.g. College Championship)
- Load games by episode number
- Create your own custom game with a CSV file
- Supports creating multiple rooms for private/simultaneous games.
- Text chat included

### Reading:

- Uses text-to-speech to read clues

### Buzzing:

- After a set time (based on number of syllables in the clue text), buzzing is unlocked
- Buzzing in enables a user to submit an answer
- Answers will be judged in buzz order

### Judging:

- Players can judge answer correctness themselves.
- An experimental AI judge powered by ChatGPT is in testing.

### Data:

- Game data is from http://j-archive.com/
- Games might be incomplete if some clues weren't revealed on the show.

## Updating Clues:

- Game data is collected using a separate j-archive-parser project and collected into a single gzipped JSON file, which this project can retrieve.

## Environment Variables

- `REDIS_URL`: Provide to allow persisting rooms to Redis so they survive server reboots
- `OPENAI_SECRET_KEY`: Provide to allow using OpenAI's ChatGPT to judge answers

## Tech

- React
- TypeScript
- Node.js
- Redis
