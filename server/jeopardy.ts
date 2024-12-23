import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { Room } from './room';
//@ts-ignore
import Papa from 'papaparse';
import { gunzipSync } from 'zlib';
import { redisCount } from './utils/redis';
import fs from 'fs';
import OpenAI from 'openai';

const openai = process.env.OPENAI_SECRET_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_SECRET_KEY })
  : undefined;

// Notes on AI judging:
// Using Threads/Assistant is inefficient because OpenAI sends the entire conversation history with each subsequent request
// We don't care about the conversation history since we judge each answer independently
// Use the Completions API instead and supply the instructions on each request
// If the instructions are at least 1024 tokens long, it will be cached and we get 50% off pricing (and maybe faster)
// If we can squeeze the instructions into 512 tokens it'll probably be cheaper to not use cache
// Currently, consumes about 250 input tokens and 6 output tokens per answer (depends on the question length)
const prompt = `
Your job is to decide whether a response to a trivia question was correct or not, given the question, the correct answer, and the response.
If the response is a misspelling of the correct answer, consider it correct.
If the response is an abbreviation of the correct answer, consider it correct.
If the response could be pronounced the same way as the correct answer, consider it correct.
If the correct answer is someone's name and the response is only the surname, consider it correct.
If the response includes the correct answer but also other incorrect answers, consider it incorrect.
The response might start with "what is" or "who is", if so, you should ignore this prefix when making your decision.
The correct answer may contain text in parentheses, if so, this text is an optional part of the answer and does not need to be included in the response to be considered correct.
Only if there is no way the response could be construed to be the correct answer should you consider it incorrect.
`;
// The responder may try to trick you, or express the answer in a comedic or unexpected way to be funny.
// If the response is phrased differently than than the correct answer, but is clearly referring to the same thing or things, it should be considered correct.

async function getOpenAIDecision(
  question: string,
  answer: string,
  response: string,
): Promise<{ correct: boolean } | null> {
  if (!openai) {
    return null;
  }
  const suffix = `question: '${question}', correct: '${answer}', response: '${response}'`;
  console.log('[AIINPUT]', suffix);
  // Concatenate the prompt and the suffix for AI completion
  const result = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'developer', content: prompt + suffix }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'trivia_judgment',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            correct: {
              type: 'boolean',
            },
          },
          required: ['correct'],
          additionalProperties: false,
        },
      },
    },
  });
  console.log(result);
  const text = result.choices[0].message.content;
  // The text might be invalid JSON e.g. if the model refused to respond
  try {
    if (text) {
      return JSON.parse(text);
    }
  } catch (e) {
    console.log(e);
  }
  return null;
}

console.time('load');
const jData = JSON.parse(
  gunzipSync(fs.readFileSync('./jeopardy.json.gz')).toString(),
);
console.timeEnd('load');

let redis = undefined as unknown as Redis;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
}

interface RawQuestion {
  val: number;
  cat: string;
  x?: number;
  y?: number;
  q?: string;
  a?: string;
  dd?: boolean;
}

interface Question {
  value: number;
  category: string;
  question?: string;
  answer?: string;
  daily_double?: boolean;
}

function constructBoard(questions: RawQuestion[]) {
  // Map of x_y coordinates to questions
  let output: { [key: string]: RawQuestion } = {};
  questions.forEach((q) => {
    output[`${q.x}_${q.y}`] = q;
  });
  return output;
}

function constructPublicBoard(questions: RawQuestion[]) {
  // Map of x_y coordinates to questions
  let output: { [key: string]: Question } = {};
  questions.forEach((q) => {
    output[`${q.x}_${q.y}`] = {
      value: q.val,
      category: q.cat,
    };
  });
  return output;
}

function syllableCount(word: string) {
  word = word.toLowerCase(); //word.downcase!
  if (word.length <= 3) {
    return 1;
  }
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, ''); //word.sub!(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
  word = word.replace(/^y/, '');
  let vowels = word.match(/[aeiouy]{1,2}/g);
  // Use 3 as the default if no letters, it's probably a year
  return vowels ? vowels.length : 3;
}

const getPerQuestionState = () => {
  return {
    currentQ: '',
    currentAnswer: undefined as string | undefined,
    currentValue: 0,
    playClueEndTS: 0,
    questionEndTS: 0,
    wagerEndTS: 0,
    buzzUnlockTS: 0,
    currentDailyDouble: false,
    canBuzz: false,
    canNextQ: false,
    currentJudgeAnswerIndex: undefined as number | undefined,
    currentJudgeAnswer: undefined as string | undefined, //socket.id
    dailyDoublePlayer: undefined as string | undefined, //socket.id
    answers: {} as Record<string, string>,
    submitted: {} as Record<string, boolean>,
    judges: {} as Record<string, boolean | null>,
    buzzes: {} as Record<string, number>,
    wagers: {} as Record<string, number>,
    // We track this separately from wagers because the list of people to wait for is different depending on context
    // e.g. for Double we only need to wait for 1 player, for final we have to wait for everyone
    waitingForWager: undefined as Record<string, boolean> | undefined,
  };
};

const getGameState = (
  options: {
    epNum?: string;
    airDate?: string;
    info?: string;
    answerTimeout?: number;
    finalTimeout?: number;
    allowMultipleCorrect?: boolean;
    host?: string;
    enableAIJudge?: boolean;
  },
  jeopardy?: Question[],
  double?: Question[],
  final?: Question[],
) => {
  return {
    jeopardy,
    double,
    final,
    answers: {} as Record<string, string>,
    wagers: {} as Record<string, number>,
    board: {} as { [key: string]: RawQuestion },
    answerTimeout: Number(options.answerTimeout) * 1000 || 20000,
    finalTimeout: Number(options.finalTimeout) * 1000 || 30000,
    enableAIJudge: options.enableAIJudge,
    public: {
      epNum: options.epNum,
      airDate: options.airDate,
      info: options.info,
      board: {} as { [key: string]: Question },
      scores: {} as Record<string, number>, // player scores
      round: '', // jeopardy or double or final
      picker: undefined as string | undefined, // If null let anyone pick, otherwise last correct answer
      host: options.host,
      allowMultipleCorrect: options.allowMultipleCorrect,
      ...getPerQuestionState(),
    },
  };
};
export type PublicGameState = ReturnType<typeof getGameState>['public'];

export class Jeopardy {
  public jpd: ReturnType<typeof getGameState>;
  // Note: snapshot is not persisted so undo is not possible if server restarts
  private jpdSnapshot: ReturnType<typeof getGameState> | undefined;
  private undoActivated: boolean | undefined = undefined;
  private io: Server;
  public roomId: string;
  private room: Room;
  private playClueTimeout: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
  private questionAnswerTimeout: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
  private wagerTimeout: NodeJS.Timeout = undefined as unknown as NodeJS.Timeout;

  constructor(io: Server, room: Room, gameData?: any) {
    this.io = io;
    this.roomId = room.roomId;
    this.room = room;
    // We keep disconnected players in roster (for some time limit?)
    // Goal is to avoid auto-skipping disconnected players for wagers and judging
    // roster is persisted so players can reconnect after server restart
    // state transfer should do answers and buzzes, and replace the roster member

    if (gameData) {
      this.jpd = gameData;
      // Reconstruct the timeouts from the saved state
      if (this.jpd.public.questionEndTS) {
        const remaining = this.jpd.public.questionEndTS - Date.now();
        console.log('[QUESTIONENDTS]', remaining);
        this.setQuestionAnswerTimeout(remaining);
      }
      if (this.jpd.public.playClueEndTS) {
        const remaining = this.jpd.public.playClueEndTS - Date.now();
        console.log('[PLAYCLUEENDTS]', remaining);
        this.setPlayClueTimeout(remaining);
      }
      if (this.jpd.public.wagerEndTS) {
        const remaining = this.jpd.public.wagerEndTS - Date.now();
        console.log('[WAGERENDTS]', remaining);
        this.setWagerTimeout(remaining, this.jpd.public.wagerEndTS);
      }
    } else {
      this.jpd = getGameState({}, [], [], []);
    }

    io.of(this.roomId).on('connection', (socket: Socket) => {
      this.jpd.public.scores[socket.id] = 0;

      const clientId = socket.handshake.query?.clientId as string;
      // clientid map keeps track of the unique clients we've seen
      // if we saw this ID already, do the reconnect logic (transfer state)
      // The list is persisted, so if the server reboots, all clients reconnect and should have state restored
      if (this.room.clientIds[clientId]) {
        const newId = socket.id;
        const oldId = this.room.clientIds[clientId];
        this.handleReconnect(newId, oldId);
      }
      if (!this.room.roster.find((p) => p.id === socket.id)) {
        // New client joining, add to roster
        this.room.roster.push({
          id: socket.id,
          name: undefined,
          connected: true,
          disconnectTime: 0,
        });
      }
      this.room.clientIds[clientId] = socket.id;

      this.emitState();
      this.sendRoster();

      socket.on('CMD:name', (data: string) => {
        if (!data) {
          return;
        }
        if (data && data.length > 100) {
          return;
        }
        const target = this.room.roster.find((p) => p.id === socket.id);
        if (target) {
          target.name = data;
          this.sendRoster();
        }
      });

      // socket.on('JPD:cmdIntro', () => {
      //   this.io.of(this.roomId).emit('JPD:playIntro');
      // });
      socket.on('JPD:start', (options, data) => {
        if (data && data.length > 1000000) {
          return;
        }
        if (typeof options !== 'object') {
          return;
        }
        this.loadEpisode(socket, options, data);
      });
      socket.on('JPD:pickQ', (id: string) => {
        if (this.jpd.public.host && socket.id !== this.jpd.public.host) {
          return;
        }
        if (
          this.jpd.public.picker &&
          // If the picker is disconnected, allow anyone to pick to avoid blocking game
          this.room
            .getConnectedRoster()
            .find((p) => p.id === this.jpd.public.picker) &&
          this.jpd.public.picker !== socket.id
        ) {
          return;
        }
        if (this.jpd.public.currentQ) {
          return;
        }
        if (!this.jpd.public.board[id]) {
          return;
        }
        this.jpd.public.currentQ = id;
        this.jpd.public.currentValue = this.jpd.public.board[id].value;
        // check if it's a daily double
        if (this.jpd.board[id].dd && !this.jpd.public.allowMultipleCorrect) {
          // if it is, don't show it yet, we need to collect wager info based only on category
          this.jpd.public.currentDailyDouble = true;
          this.jpd.public.dailyDoublePlayer = socket.id;
          this.jpd.public.waitingForWager = { [socket.id]: true };
          this.setWagerTimeout(this.jpd.answerTimeout);
          // Autobuzz the player who picked the DD, all others pass
          // Note: if a player joins during wagering, they might not be marked as passed (submitted)
          // Currently client doesn't show the answer box because it checks for buzzed in players
          // But there's probably no server block on them submitting answers
          this.room.roster.forEach((p) => {
            if (p.id === socket.id) {
              this.jpd.public.buzzes[p.id] = Date.now();
            } else {
              this.jpd.public.submitted[p.id] = true;
            }
          });
          this.io.of(this.roomId).emit('JPD:playDailyDouble');
        } else {
          // Put Q in public state
          this.jpd.public.board[this.jpd.public.currentQ].question =
            this.jpd.board[this.jpd.public.currentQ].q;
          this.triggerPlayClue();
        }
        // Undo no longer possible after next question is picked
        this.jpdSnapshot = undefined;
        this.undoActivated = undefined;
        this.emitState();
      });
      socket.on('JPD:buzz', () => {
        if (!this.jpd.public.canBuzz) {
          return;
        }
        if (this.jpd.public.buzzes[socket.id]) {
          return;
        }
        this.jpd.public.buzzes[socket.id] = Date.now();
        this.emitState();
      });
      socket.on('JPD:answer', (question, answer) => {
        if (question !== this.jpd.public.currentQ) {
          // Not submitting for right question
          return;
        }
        if (!this.jpd.public.questionEndTS) {
          // Time was already up
          return;
        }
        if (answer && answer.length > 10000) {
          // Answer too long
          return;
        }
        console.log('[ANSWER]', socket.id, question, answer);
        if (answer) {
          this.jpd.answers[socket.id] = answer;
        }
        this.jpd.public.submitted[socket.id] = true;
        this.emitState();
        if (
          this.jpd.public.round !== 'final' &&
          // If a player disconnects, don't wait for their answer
          this.room
            .getConnectedRoster()
            .every((p) => p.id in this.jpd.public.submitted)
        ) {
          this.revealAnswer();
        }
      });

      socket.on('JPD:wager', (wager) => this.submitWager(socket.id, wager));
      socket.on('JPD:judge', (data) => this.doHumanJudge(socket, data));
      socket.on('JPD:bulkJudge', (data) => {
        // Check if the next player to be judged is in the input data
        // If so, doJudge for that player
        // Check if we advanced to the next question, otherwise keep doing doJudge
        while (this.jpd.public.currentJudgeAnswer !== undefined) {
          const id = this.jpd.public.currentJudgeAnswer;
          const match = data.find((d: any) => d.id === id);
          if (match) {
            this.doHumanJudge(socket, match);
          } else {
            // Player to be judged isn't in the input
            // Stop judging and revert to manual (or let the user resubmit, we should prevent duplicates)
            break;
          }
        }
      });
      socket.on('JPD:undo', () => {
        if (this.jpd.public.host && socket.id !== this.jpd.public.host) {
          // Not the host
          return;
        }
        // Reset the game state to the last snapshot
        // Snapshot updates at each revealAnswer
        if (this.jpdSnapshot) {
          this.undoActivated = true;
          this.jpd = JSON.parse(JSON.stringify(this.jpdSnapshot));
          this.advanceJudging(false);
          this.emitState();
        }
      });
      socket.on('JPD:skipQ', () => {
        if (this.jpd.public.canNextQ) {
          // We are in the post-judging phase and can move on
          this.nextQuestion();
        }
      });
      socket.on('disconnect', () => {
        if (this.jpd && this.jpd.public) {
          // If player who needs to submit wager leaves, submit 0
          if (
            this.jpd.public.waitingForWager &&
            this.jpd.public.waitingForWager[socket.id]
          ) {
            this.submitWager(socket.id, 0);
          }
        }
        // Mark the user disconnected
        let target = this.room.roster.find((p) => p.id === socket.id);
        if (target) {
          target.connected = false;
          target.disconnectTime = Date.now();
        }
        this.sendRoster();
      });
    });

    setInterval(() => {
      // Remove players that have been disconnected for a long time
      const beforeLength = this.room.roster.length;
      const now = Date.now();
      this.room.roster = this.room.roster.filter(
        (p) => p.connected || now - p.disconnectTime < 60 * 60 * 1000,
      );
      const afterLength = this.room.roster.length;
      if (beforeLength !== afterLength) {
        this.sendRoster();
      }
    }, 60000);
  }

  loadEpisode(socket: Socket, options: GameOptions, custom: string) {
    let {
      number,
      filter,
      answerTimeout,
      finalTimeout,
      makeMeHost,
      allowMultipleCorrect,
      enableAIJudge,
    } = options;
    console.log('[LOADEPISODE]', number, filter, Boolean(custom));
    let loadedData = null;
    if (custom) {
      try {
        const parse = Papa.parse(custom, { header: true });
        const typed = [];
        let round = '';
        let cat = '';
        let curX = 0;
        let curY = 0;
        for (let i = 0; i < parse.data.length; i++) {
          const d = parse.data[i];
          if (round !== d.round) {
            // Reset x and y to 1
            curX = 1;
            curY = 1;
          } else if (cat !== d.cat) {
            // Increment x, reset y to 1, new category
            curX += 1;
            curY = 1;
          } else {
            curY += 1;
          }
          round = d.round;
          cat = d.cat;
          let multiplier = 1;
          if (round === 'double') {
            multiplier = 2;
          } else if (round === 'final') {
            multiplier = 0;
          }
          if (d.q && d.a) {
            typed.push({
              round: d.round,
              cat: d.cat,
              q: d.q,
              a: d.a,
              dd: d.dd?.toLowerCase() === 'true',
              val: curY * 200 * multiplier,
              x: curX,
              y: curY,
            });
          }
        }
        loadedData = {
          airDate: new Date().toISOString().split('T')[0],
          epNum: 'Custom',
          jeopardy: typed.filter((d: any) => d.round === 'jeopardy'),
          double: typed.filter((d: any) => d.round === 'double'),
          final: typed.filter((d: any) => d.round === 'final'),
        };
        redisCount('customGames');
      } catch (e) {
        console.warn(e);
      }
    } else {
      // Load question data into game
      let nums = Object.keys(jData);
      if (filter) {
        // Only load episodes with info matching the filter: kids, teen, college etc.
        nums = nums.filter(
          (num) =>
            (jData as any)[num].info && (jData as any)[num].info === filter,
        );
      }
      if (number === 'ddtest') {
        loadedData = jData['8000'];
        loadedData['jeopardy'] = loadedData['jeopardy'].filter(
          (q: any) => q.dd,
        );
      } else if (number === 'finaltest') {
        loadedData = jData['8000'];
      } else {
        if (!number) {
          // Random an episode
          number = nums[Math.floor(Math.random() * nums.length)];
        }
        loadedData = (jData as any)[number];
      }
    }
    if (loadedData) {
      redisCount('newGames');
      const { epNum, airDate, info, jeopardy, double, final } = loadedData;
      this.jpd = getGameState(
        {
          epNum,
          airDate,
          info,
          finalTimeout,
          answerTimeout,
          host: makeMeHost ? socket.id : undefined,
          allowMultipleCorrect,
          enableAIJudge,
        },
        jeopardy,
        double,
        final,
      );
      this.jpdSnapshot = undefined;
      if (number === 'finaltest') {
        this.jpd.public.round = 'double';
      }
      this.nextRound();
    }
  }

  emitState() {
    this.io.of(this.roomId).emit('JPD:state', this.jpd.public);
  }

  sendRoster() {
    // Sort by score and resend the list of players to everyone
    this.room.roster.sort(
      (a, b) =>
        (this.jpd.public?.scores[b.id] || 0) -
        (this.jpd.public?.scores[a.id] || 0),
    );
    this.io.of(this.roomId).emit('roster', this.room.roster);
  }

  handleReconnect(newId: string, oldId: string) {
    console.log('[RECONNECT] transfer %s to %s', oldId, newId);
    // Update the roster with the new ID and connected state
    const target = this.room.roster.find((p) => p.id === oldId);
    if (target) {
      target.id = newId;
      target.connected = true;
      target.disconnectTime = 0;
    }
    if (this.jpd.public.scores?.[oldId]) {
      this.jpd.public.scores[newId] = this.jpd.public.scores[oldId];
      delete this.jpd.public.scores[oldId];
    }
    if (this.jpd.public.buzzes?.[oldId]) {
      this.jpd.public.buzzes[newId] = this.jpd.public.buzzes[oldId];
      delete this.jpd.public.buzzes[oldId];
    }
    if (this.jpd.public.judges?.[oldId]) {
      this.jpd.public.judges[newId] = this.jpd.public.judges[oldId];
      delete this.jpd.public.judges[oldId];
    }
    if (this.jpd.public.submitted?.[oldId]) {
      this.jpd.public.submitted[newId] = this.jpd.public.submitted[oldId];
      delete this.jpd.public.submitted[oldId];
    }
    if (this.jpd.public.answers?.[oldId]) {
      this.jpd.public.answers[newId] = this.jpd.public.answers[oldId];
      delete this.jpd.public.answers[oldId];
    }
    if (this.jpd.public.wagers?.[oldId]) {
      this.jpd.public.wagers[newId] = this.jpd.public.wagers[oldId];
      delete this.jpd.public.wagers[oldId];
    }
    // Note: two copies of answers and wagers exist, a public and non-public version, so we need to copy both
    // Alternatively, we can just have some state to tracks whether to emit the answers and wagers and keep both in public only
    if (this.jpd.answers?.[oldId]) {
      this.jpd.answers[newId] = this.jpd.answers[oldId];
      delete this.jpd.answers[oldId];
    }
    if (this.jpd.wagers?.[oldId]) {
      this.jpd.wagers[newId] = this.jpd.wagers[oldId];
      delete this.jpd.wagers[oldId];
    }
    if (this.jpd.public.waitingForWager?.[oldId]) {
      // Current behavior is to submit wager 0 if disconnecting
      // So there should be no state to transfer
      this.jpd.public.waitingForWager[newId] = true;
      delete this.jpd.public.waitingForWager[oldId];
    }
    if (this.jpd.public.currentJudgeAnswer === oldId) {
      this.jpd.public.currentJudgeAnswer = newId;
    }
    if (this.jpd.public.dailyDoublePlayer === oldId) {
      this.jpd.public.dailyDoublePlayer = newId;
    }
    if (this.jpd.public.picker === oldId) {
      this.jpd.public.picker = newId;
    }
    if (this.jpd.public.host === oldId) {
      this.jpd.public.host = newId;
    }
  }

  playCategories() {
    this.io.of(this.roomId).emit('JPD:playCategories');
  }

  resetAfterQuestion() {
    this.jpd.answers = {};
    this.jpd.wagers = {};
    clearTimeout(this.playClueTimeout);
    clearTimeout(this.questionAnswerTimeout);
    clearTimeout(this.wagerTimeout);
    this.jpd.public = { ...this.jpd.public, ...getPerQuestionState() };
    // Overwrite any other picker settings if there's a host
    if (this.jpd.public.host) {
      this.jpd.public.picker = this.jpd.public.host;
    }
  }

  nextQuestion() {
    // Show the correct answer in the game log
    this.room.addChatMessage(undefined, {
      id: '',
      name: 'System',
      cmd: 'answer',
      msg: this.jpd.public.currentAnswer,
    });
    // Scores have updated so resend sorted player list
    this.sendRoster();
    // Reset question state
    delete this.jpd.public.board[this.jpd.public.currentQ];
    this.resetAfterQuestion();
    if (Object.keys(this.jpd.public.board).length === 0) {
      this.nextRound();
    } else {
      this.emitState();
      // TODO may want to introduce some delay here to make sure our state is updated before reading selection
      this.io.of(this.roomId).emit('JPD:playMakeSelection');
    }
  }

  nextRound() {
    this.resetAfterQuestion();
    // advance round counter
    if (this.jpd.public.round === 'jeopardy') {
      this.jpd.public.round = 'double';
      // If double, person with lowest score is picker
      // Unless we are allowing multiple corrects or there's a host
      // This is nlogn rather than n, but prob ok for small numbers of players
      if (!this.jpd.public.allowMultipleCorrect && !this.jpd.public.host) {
        // Pick the lowest score out of the currently connected players
        const playersWithScores = this.room.getConnectedRoster().map((p) => ({
          id: p.id,
          score: this.jpd.public.scores[p.id] || 0,
        }));
        playersWithScores.sort((a, b) => a.score - b.score);
        this.jpd.public.picker = playersWithScores[0]?.id;
      }
    } else if (this.jpd.public.round === 'double') {
      this.jpd.public.round = 'final';
      const now = Date.now();
      this.jpd.public.waitingForWager = {};
      // Ask all players for wager (including disconnected since they might come back)
      this.room.roster.forEach((p) => {
        this.jpd.public.waitingForWager![p.id] = true;
      });
      this.setWagerTimeout(this.jpd.finalTimeout);
      // autopick the question
      this.jpd.public.currentQ = '1_1';
      // autobuzz the players in ascending score order
      let playerIds = this.room.roster.map((p) => p.id);
      playerIds.sort(
        (a, b) =>
          Number(this.jpd.public.scores[a] || 0) -
          Number(this.jpd.public.scores[b] || 0),
      );
      playerIds.forEach((pid) => {
        this.jpd.public.buzzes[pid] = now;
      });
      // Play the category sound
      this.io.of(this.roomId).emit('JPD:playRightanswer');
    } else if (this.jpd.public.round === 'final') {
      this.jpd.public.round = 'end';
      // Log the results
      const scores = Object.entries(this.jpd.public.scores);
      scores.sort((a, b) => b[1] - a[1]);
      const scoresNames = scores.map((score) => [
        this.room.roster.find((p) => p.id === score[0])?.name,
        score[1],
      ]);
      redis?.lpush('jpd:results', JSON.stringify(scoresNames));
    } else {
      this.jpd.public.round = 'jeopardy';
    }
    if (
      this.jpd.public.round === 'jeopardy' ||
      this.jpd.public.round === 'double' ||
      this.jpd.public.round === 'final'
    ) {
      this.jpd.board = constructBoard((this.jpd as any)[this.jpd.public.round]);
      this.jpd.public.board = constructPublicBoard(
        (this.jpd as any)[this.jpd.public.round],
      );
      if (Object.keys(this.jpd.public.board).length === 0) {
        this.nextRound();
      }
    }
    this.emitState();
    if (
      this.jpd.public.round === 'jeopardy' ||
      this.jpd.public.round === 'double'
    ) {
      console.log('[PLAYCATEGORIES]', this.jpd.public.round);
      this.playCategories();
    }
  }

  unlockAnswer(durationMs: number) {
    this.jpd.public.questionEndTS = Date.now() + durationMs;
    this.setQuestionAnswerTimeout(durationMs);
  }

  setQuestionAnswerTimeout(durationMs: number) {
    this.questionAnswerTimeout = setTimeout(() => {
      if (this.jpd.public.round !== 'final') {
        this.io.of(this.roomId).emit('JPD:playTimesUp');
      }
      this.revealAnswer();
    }, durationMs);
  }

  revealAnswer() {
    clearTimeout(this.questionAnswerTimeout);
    this.jpd.public.questionEndTS = 0;

    // Add empty answers for anyone who buzzed but didn't submit anything
    Object.keys(this.jpd.public.buzzes).forEach((key) => {
      if (!this.jpd.answers[key]) {
        this.jpd.answers[key] = '';
      }
    });
    this.jpd.public.canBuzz = false;
    // Show everyone's answers
    this.jpd.public.answers = { ...this.jpd.answers };
    this.jpd.public.currentAnswer = this.jpd.board[this.jpd.public.currentQ]?.a;
    this.jpdSnapshot = JSON.parse(JSON.stringify(this.jpd));
    this.advanceJudging(false);
    this.emitState();
  }

  advanceJudging(skipJudging: boolean) {
    if (this.jpd.public.currentJudgeAnswerIndex === undefined) {
      this.jpd.public.currentJudgeAnswerIndex = 0;
    } else {
      this.jpd.public.currentJudgeAnswerIndex += 1;
    }
    this.jpd.public.currentJudgeAnswer = Object.keys(this.jpd.public.buzzes)[
      this.jpd.public.currentJudgeAnswerIndex
    ];
    // Either we picked a correct answer (in standard mode) or ran out of players to judge
    if (skipJudging || this.jpd.public.currentJudgeAnswer === undefined) {
      this.jpd.public.canNextQ = true;
    }
    if (this.jpd.public.currentJudgeAnswer) {
      // In Final, reveal one at a time rather than all at once (for dramatic purposes)
      // Note: Looks like we just bulk reveal answers elsewhere, so this is just wagers
      this.jpd.public.wagers[this.jpd.public.currentJudgeAnswer] =
        this.jpd.wagers[this.jpd.public.currentJudgeAnswer];
      this.jpd.public.answers[this.jpd.public.currentJudgeAnswer] =
        this.jpd.answers[this.jpd.public.currentJudgeAnswer];
    }
    // Undo snapshots the current state of jpd
    // So if a player has reconnected since with a new ID the ID from buzzes might not be there anymore
    // If so, we skip that answer (not optimal but easiest)
    // TODO To fix this we probably have to use clientId instead of socket id to index the submitted answers
    if (
      this.jpd.public.currentJudgeAnswer &&
      !this.room.roster.find((p) => p.id === this.jpd.public.currentJudgeAnswer)
    ) {
      console.log(
        '[ADVANCEJUDGING] player not found, moving on:',
        this.jpd.public.currentJudgeAnswer,
      );
      this.advanceJudging(skipJudging);
      return;
    }
    // If user undoes, disable AI judge to prevent loop
    if (
      openai &&
      this.jpd.enableAIJudge &&
      !this.undoActivated &&
      this.jpd.public.currentJudgeAnswer
    ) {
      // We don't await here since AI judging shouldn't block UI
      // But we want to trigger it whenever we move on to the next answer
      // The result might come back after we already manually judged, in that case we just log it and ignore
      this.doAiJudge({
        currentQ: this.jpd.public.currentQ,
        id: this.jpd.public.currentJudgeAnswer,
      });
    }
  }

  async doAiJudge(data: { currentQ: string; id: string }) {
    // currentQ: The board coordinates of the current question, e.g. 1_3
    // id: socket id of the person being judged
    const { currentQ, id } = data;
    // The question text
    const q = this.jpd.board[currentQ]?.q ?? '';
    const a = this.jpd.public.currentAnswer ?? '';
    const response = this.jpd.public.answers[id];
    const decision = await getOpenAIDecision(q, a, response);
    console.log('[AIDECISION]', id, q, a, response, decision);
    const correct = decision?.correct;
    if (correct != null) {
      // Log the AI decision along with whether the user agreed with it (accuracy)
      // If the user undoes and then chooses differently than AI, then that's a failed decision
      // Alternative: we can just highlight what the AI thinks is correct instead of auto-applying the decision, then we'll have user feedback for sure
      if (redis) {
        redis.lpush(
          'jpd:aiJudges',
          JSON.stringify({ q, a, response, correct }),
        );
      }
      this.judgeAnswer(undefined, { currentQ, id, correct });
    }
  }

  doHumanJudge(
    socket: Socket,
    data: { currentQ: string; id: string; correct: boolean | null },
  ) {
    const answer = this.jpd.public.currentAnswer;
    const submitted = this.jpd.public.answers[data.id];
    const success = this.judgeAnswer(socket, data);
    if (success) {
      if (data.correct && redis) {
        // If the answer was judged correct and non-trivial (equal lowercase), log it for analysis
        if (answer?.toLowerCase() !== submitted?.toLowerCase()) {
          redis.lpush('jpd:nonTrivialJudges', `${answer},${submitted},${1}`);
          // redis.ltrim('jpd:nonTrivialJudges', 0, 100000);
        }
      }
    }
  }

  judgeAnswer(
    socket: Socket | undefined,
    {
      currentQ,
      id,
      correct,
    }: { currentQ: string; id: string; correct: boolean | null },
  ) {
    if (id in this.jpd.public.judges) {
      // Already judged this player
      return false;
    }
    if (currentQ !== this.jpd.public.currentQ) {
      // Not judging the right question
      return false;
    }
    if (this.jpd.public.currentJudgeAnswer === undefined) {
      // Not in judging step
      return false;
    }
    if (this.jpd.public.host && socket?.id !== this.jpd.public.host) {
      // Not the host
      return;
    }
    this.jpd.public.judges[id] = correct;
    console.log('[JUDGE]', id, correct);
    if (!this.jpd.public.scores[id]) {
      this.jpd.public.scores[id] = 0;
    }
    const delta = this.jpd.public.wagers[id] || this.jpd.public.currentValue;
    if (correct === true) {
      this.jpd.public.scores[id] += delta;
      if (!this.jpd.public.allowMultipleCorrect) {
        // Correct answer is next picker
        this.jpd.public.picker = id;
      }
    }
    if (correct === false) {
      this.jpd.public.scores[id] -= delta;
    }
    // If null/undefined, don't change scores
    if (correct != null) {
      const msg = {
        id: socket?.id ?? '',
        // name of judge
        name:
          this.room.roster.find((p) => p.id === socket?.id)?.name ?? 'System',
        cmd: 'judge',
        msg: JSON.stringify({
          id: id,
          // name of person being judged
          name: this.room.roster.find((p) => p.id === id)?.name,
          answer: this.jpd.public.answers[id],
          correct,
          delta: correct ? delta : -delta,
        }),
      };
      this.room.addChatMessage(socket, msg);
    }
    const allowMultipleCorrect =
      this.jpd.public.round === 'final' || this.jpd.public.allowMultipleCorrect;
    const skipJudging = !allowMultipleCorrect && correct === true;
    this.advanceJudging(skipJudging);

    if (this.jpd.public.canNextQ) {
      this.nextQuestion();
    } else {
      this.emitState();
    }
    return correct !== null;
  }

  submitWager(id: string, wager: number) {
    if (id in this.jpd.wagers) {
      return;
    }
    // User setting a wager for DD or final
    // Can bet up to current score, minimum of 1000 in single or 2000 in double, 0 in final
    let maxWager = 0;
    let minWager = 5;
    if (this.jpd.public.round === 'jeopardy') {
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 1000);
    } else if (this.jpd.public.round === 'double') {
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 2000);
    } else if (this.jpd.public.round === 'final') {
      minWager = 0;
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 0);
    }
    let numWager = Number(wager);
    if (Number.isNaN(Number(wager))) {
      numWager = minWager;
    } else {
      numWager = Math.min(Math.max(numWager, minWager), maxWager);
    }
    console.log('[WAGER]', id, wager, numWager);
    if (id === this.jpd.public.dailyDoublePlayer && this.jpd.public.currentQ) {
      this.jpd.wagers[id] = numWager;
      this.jpd.public.wagers[id] = numWager;
      this.jpd.public.waitingForWager = undefined;
      if (this.jpd.public.board[this.jpd.public.currentQ]) {
        this.jpd.public.board[this.jpd.public.currentQ].question =
          this.jpd.board[this.jpd.public.currentQ]?.q;
      }
      this.triggerPlayClue();
      this.emitState();
    }
    if (this.jpd.public.round === 'final' && this.jpd.public.currentQ) {
      // store the wagers privately until everyone's made one
      this.jpd.wagers[id] = numWager;
      if (this.jpd.public.waitingForWager) {
        delete this.jpd.public.waitingForWager[id];
      }
      if (Object.keys(this.jpd.public.waitingForWager ?? {}).length === 0) {
        // if final, reveal clue if all players made wager
        this.jpd.public.waitingForWager = undefined;
        if (this.jpd.public.board[this.jpd.public.currentQ]) {
          this.jpd.public.board[this.jpd.public.currentQ].question =
            this.jpd.board[this.jpd.public.currentQ]?.q;
        }
        this.triggerPlayClue();
      }
      this.emitState();
    }
  }

  setWagerTimeout(durationMs: number, endTS?: number) {
    this.jpd.public.wagerEndTS = endTS ?? Date.now() + durationMs;
    this.wagerTimeout = setTimeout(() => {
      Object.keys(this.jpd.public.waitingForWager ?? {}).forEach((id) => {
        this.submitWager(id, 0);
      });
    }, durationMs);
  }

  triggerPlayClue() {
    clearTimeout(this.wagerTimeout);
    this.jpd.public.wagerEndTS = 0;
    const clue = this.jpd.public.board[this.jpd.public.currentQ];
    this.io
      .of(this.roomId)
      .emit('JPD:playClue', this.jpd.public.currentQ, clue && clue.question);
    let speakingTime = 0;
    if (clue && clue.question) {
      // Allow some time for reading the text, based on content
      // Count syllables in text, assume speaking rate of 4 syll/sec
      const syllCountArr = clue.question
        // Remove parenthetical starts and blanks
        .replace(/^\(.*\)/, '')
        .replace(/_+/g, ' blank ')
        .split(' ')
        .map((word: string) => syllableCount(word));
      const totalSyll = syllCountArr.reduce((a: number, b: number) => a + b, 0);
      // Minimum 1 second speaking time
      speakingTime = Math.max((totalSyll / 4) * 1000, 1000);
      console.log('[TRIGGERPLAYCLUE]', clue.question, totalSyll, speakingTime);
      this.jpd.public.playClueEndTS = Date.now() + speakingTime;
    }
    this.setPlayClueTimeout(speakingTime);
  }

  setPlayClueTimeout(durationMs: number) {
    this.playClueTimeout = setTimeout(() => {
      this.playClueDone();
    }, durationMs);
  }

  playClueDone() {
    console.log('[PLAYCLUEDONE]');
    clearTimeout(this.playClueTimeout);
    this.jpd.public.playClueEndTS = 0;
    this.jpd.public.buzzUnlockTS = Date.now();
    if (this.jpd.public.round === 'final') {
      this.unlockAnswer(this.jpd.finalTimeout);
      // Play final jeopardy music
      this.io.of(this.roomId).emit('JPD:playFinalJeopardy');
    } else {
      if (!this.jpd.public.currentDailyDouble) {
        // DD already handles buzzing automatically
        this.jpd.public.canBuzz = true;
      }
      this.unlockAnswer(this.jpd.answerTimeout);
    }
    this.emitState();
  }

  toJSON() {
    return this.jpd;
  }
}
