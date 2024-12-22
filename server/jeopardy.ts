import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { Room } from './room';
//@ts-ignore
import Papa from 'papaparse';
import { gunzipSync } from 'zlib';
import { redisCount } from './utils/redis';
import fs from 'fs';

console.time('load');
const jData = JSON.parse(gunzipSync(fs.readFileSync('./jeopardy.json.gz')).toString());
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

function getPerQuestionState() {
  return {
    currentQ: '',
    currentAnswer: undefined as string | undefined,
    currentValue: 0,
    currentJudgeAnswer: undefined as string | undefined,
    currentJudgeAnswerIndex: undefined as number | undefined,
    currentDailyDouble: false,
    waitingForWager: undefined as BooleanDict | undefined,
    playClueDuration: 0,
    playClueEndTS: 0,
    questionDuration: 0,
    questionEndTS: 0,
    wagerEndTS: 0,
    wagerDuration: 0,
    buzzUnlockTS: 0,
    answers: {} as StringDict,
    submitted: {} as BooleanDict,
    buzzes: {} as NumberDict,
    readings: {} as BooleanDict,
    judges: {} as BooleanDict,
    wagers: {} as NumberDict,
    canBuzz: false,
    canNextQ: false,
    dailyDoublePlayer: undefined as string | undefined,
  };
}

function getGameState(
  options: {
    epNum?: string,
    airDate?: string,
    info?: string,
    answerTimeout?: number,
    finalTimeout?: number,
    allowMultipleCorrect?: boolean,
    host?: string,
  },
  jeopardy?: Question[],
  double?: Question[],
  final?: Question[],
) {
  return {
    jeopardy,
    double,
    final,
    answers: {} as StringDict,
    wagers: {} as NumberDict,
    board: {} as { [key: string]: RawQuestion },
    answerTimeout: (Number(options.answerTimeout) * 1000) || 20000,
    finalTimeout: (Number(options.finalTimeout) * 1000) || 30000,
    public: {
      epNum: options.epNum,
      airDate: options.airDate,
      info: options.info,
      board: {} as { [key: string]: Question },
      scores: {} as NumberDict, // player scores
      round: '', // jeopardy or double or final
      picker: undefined as string | undefined, // If null let anyone pick, otherwise last correct answer
      host: options.host,
      allowMultipleCorrect: options.allowMultipleCorrect,
      ...getPerQuestionState(),
    },
  };
}

export class Jeopardy {
  public jpd: ReturnType<typeof getGameState>;
  private jpdSnapshot: ReturnType<typeof getGameState> | undefined;
  public roomId: string;
  private io: Server;
  private roster: User[];
  private room: Room;
  private playClueTimeout: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
  private questionAnswerTimeout: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
  private wagerTimeout: NodeJS.Timeout = undefined as unknown as NodeJS.Timeout;

  constructor(
    io: Server,
    roomId: string,
    roster: User[],
    room: Room,
    gameData?: any,
  ) {
    this.io = io;
    this.roomId = roomId;
    this.roster = roster;
    this.room = room;

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
      this.roster.push({ id: socket.id, name: undefined });

      this.emitState();
      this.sendRoster();

      socket.on('CMD:name', (data: string) => {
        if (!data) {
          return;
        }
        if (data && data.length > 100) {
          return;
        }
        const target = this.roster.find(p => p.id === socket.id);
        if (target) {
          target.name = data;
          this.sendRoster();
        }
      });

      // socket.on('JPD:cmdIntro', () => {
      //   this.io.of(this.roomId).emit('JPD:playIntro');
      // });
      socket.on('JPD:reconnect', (id: string) => {
        // TODO add some validation to prevent users from spoofing reconnection
        // Maybe require a UUID that's generated by each client and not shared (unlike socket IDs?)
        // Transfer old state to this player
        if (this.jpd.public.scores && this.jpd.public.scores[id]) {
          this.jpd.public.scores[socket.id] = this.jpd.public.scores[id];
          delete this.jpd.public.scores[id];
        }
        if (this.jpd.wagers && this.jpd.wagers[id]) {
          this.jpd.wagers[socket.id] = this.jpd.wagers[id];
          delete this.jpd.wagers[id];
        }
        if (this.jpd.public.buzzes && this.jpd.public.buzzes[id]) {
          this.jpd.public.buzzes[socket.id] = this.jpd.public.buzzes[id];
          delete this.jpd.public.buzzes[id];
        }
        if (this.jpd.public.dailyDoublePlayer === id) {
          this.jpd.public.dailyDoublePlayer = socket.id;
        }
        if (this.jpd.public.picker === id) {
          this.jpd.public.picker = socket.id;
        }
        if (this.jpd.public.host === id) {
          this.jpd.public.host = socket.id;
        }
        this.emitState();
        // We may need to send the roster again since scores updated
        this.sendRoster();
      });
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
          this.roster.find((p) => p.id === this.jpd.public.picker) &&
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
          // Autobuzz the player, all others pass
          this.roster.forEach((p) => {
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
        if (!this.jpd.public.questionDuration) {
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
          this.roster.every((p) => p.id in this.jpd.public.submitted)
        ) {
          this.revealAnswer();
        }
      });

      socket.on('JPD:wager', (wager) => this.submitWager(socket.id, wager));
      socket.on('JPD:judge', (data) => this.doJudge(socket, data));
      socket.on('JPD:bulkJudge', (data) => {
        // Check if the next player to be judged is in the input data
        // If so, doJudge for that player
        // Check if we advanced to the next question, otherwise keep doing doJudge
        while (this.jpd.public.currentJudgeAnswer !== undefined) {
          const id = this.jpd.public.currentJudgeAnswer;
          const match = data.find((d: any) => d.id === id);
          if (match) {
            this.doJudge(socket, match);
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
          this.jpd = JSON.parse(JSON.stringify(this.jpdSnapshot));
          this.advanceJudging(false);
          this.emitState();
        }
      });
      socket.on('JPD:skipQ', () => {
        if (
          this.jpd.public.canNextQ
        ) {
          // We are in the post-judging phase and can move on
          this.nextQuestion();
        }
      });
      socket.on('disconnect', () => {
        if (this.jpd && this.jpd.public) {
          // If player being judged leaves, skip their answer
          if (this.jpd.public.currentJudgeAnswer === socket.id) {
            // This is to run the rest of the code around judging
            this.judgeAnswer(undefined, { currentQ: this.jpd.public.currentQ, id: socket.id, correct: null });
          }
          // If player who needs to submit wager leaves, submit 0
          if (
            this.jpd.public.waitingForWager &&
            this.jpd.public.waitingForWager[socket.id]
          ) {
            this.submitWager(socket.id, 0);
          }
        }
        let index = this.roster.findIndex((user) => user.id === socket.id);
        this.roster.splice(index, 1)[0];
        this.sendRoster();
      });
    });
  }

  loadEpisode(socket: Socket, options: GameOptions, custom: string) {
    let { number, filter, answerTimeout, finalTimeout, makeMeHost, allowMultipleCorrect } = options;
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
      this.jpd = getGameState({ epNum, airDate, info, finalTimeout, answerTimeout, host: makeMeHost ? socket.id : undefined, allowMultipleCorrect }, jeopardy, double, final);
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
    this.roster.sort(
      (a, b) => (this.jpd.public?.scores[b.id] || 0) - (this.jpd.public?.scores[a.id] || 0),
    );
    this.io.of(this.roomId).emit('roster', this.roster);
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
        const playersWithScores = this.roster.map((p) => ({
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
      this.roster.forEach((p) => {
        this.jpd.public.waitingForWager![p.id] = true;
      });
      this.setWagerTimeout(this.jpd.finalTimeout);
      // autopick the question
      this.jpd.public.currentQ = '1_1';
      // autobuzz the players in ascending score order
      let playerIds = this.roster.map((p) => p.id);
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
        this.roster.find(p => p.id === score[0])?.name,
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
    this.jpd.public.questionDuration = durationMs;
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
    this.jpd.public.questionDuration = 0;
    this.jpd.public.questionEndTS = 0;

    // Add empty answers for anyone who buzzed but didn't submit anything
    Object.keys(this.jpd.public.buzzes).forEach((key) => {
      if (!this.jpd.answers[key]) {
        this.jpd.answers[key] = '';
      }
    });
    this.jpd.public.canBuzz = false;
    this.jpd.public.answers = { ...this.jpd.answers };
    this.jpd.public.currentAnswer = this.jpd.board[this.jpd.public.currentQ]?.a;
    this.jpdSnapshot = JSON.parse(JSON.stringify(this.jpd));
    this.advanceJudging(false);
    this.emitState();
  }

  advanceJudging(skipJudging: boolean) {
    console.log('[ADVANCEJUDGING]', this.jpd.public.currentJudgeAnswerIndex);
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
      // Show the player's wager and answer to everyone
      this.jpd.public.wagers[this.jpd.public.currentJudgeAnswer] =
        this.jpd.wagers[this.jpd.public.currentJudgeAnswer];
      this.jpd.public.answers[this.jpd.public.currentJudgeAnswer] =
        this.jpd.answers[this.jpd.public.currentJudgeAnswer];
    }

    // If the current judge player isn't connected, advance again
    if (
      this.jpd.public.currentJudgeAnswer &&
      !this.roster.find((p) => p.id === this.jpd.public.currentJudgeAnswer)
    ) {
      console.log(
        '[ADVANCEJUDGING] player not found, moving on:',
        this.jpd.public.currentJudgeAnswer,
      );
      this.advanceJudging(skipJudging);
    }
  }

  doJudge(socket: Socket, data: { currentQ: string, id: string; correct: boolean | null }) {
    const answer = this.jpd.public.currentAnswer;
    const submitted = this.jpd.public.answers[data.id];
    const success = this.judgeAnswer(socket, data);
    if (success) {
      if (data.correct && redis) {
        // If the answer was judged correct and non-trivial (equal lowercase), log it for analysis
        if (answer?.toLowerCase() !== submitted?.toLowerCase()) {
          redis.lpush(
            'jpd:nonTrivialJudges',
            `${answer},${submitted},${1}`,
          );
          // redis.ltrim('jpd:nonTrivialJudges', 0, 100000);
        }
      }
    }
  }

  judgeAnswer(
    socket: Socket | undefined,
    { currentQ, id, correct }: { currentQ: string, id: string; correct: boolean | null },
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
    // Currently anyone can pick the correct answer
    // Can turn this into a vote or make a non-player the host
    // MAYBE attempt auto-judging using fuzzy string match
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
    // If null, don't change scores

    if (socket && correct != null) {
      const msg = {
        id: socket.id,
        // name of judge
        name: this.roster.find(p => p.id === socket.id)?.name,
        cmd: 'judge',
        msg: JSON.stringify({
          id: id,
          // name of person being judged
          name: this.roster.find(p => p.id === id)?.name,
          answer: this.jpd.public.answers[id],
          correct,
          delta: correct ? delta : -delta,
        }),
      };
      this.room.addChatMessage(socket, msg);
    }
    const allowMultipleCorrect = this.jpd.public.round === 'final' || this.jpd.public.allowMultipleCorrect;
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
    this.jpd.public.wagerDuration = durationMs;
    this.wagerTimeout = setTimeout(() => {
      Object.keys(this.jpd.public.waitingForWager ?? {}).forEach((id) => {
        this.submitWager(id, 0);
      });
    }, durationMs);
  }

  triggerPlayClue() {
    clearTimeout(this.wagerTimeout);
    this.jpd.public.wagerDuration = 0;
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
      this.jpd.public.playClueDuration = speakingTime;
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
    this.jpd.public.playClueDuration = 0;
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
