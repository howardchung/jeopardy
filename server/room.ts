import { Socket, Server } from 'socket.io';
import Papa from 'papaparse';
import { redis, redisCount } from './redis';
import { genAITextToSpeech } from './aivoice';
import { getOpenAIDecision, openai } from './openai';
import config from './config';
import { getGameState, getPerQuestionState } from './gamestate';
import { getJData } from './jData';

export class Room {
  // Serialized state
  public roster: User[] = [];
  public clientIds: Record<string, string> = {};
  private chat: ChatMessage[] = [];
  public creationTime: Date = new Date();
  public jpd: ReturnType<typeof getGameState> = getGameState({}, [], [], []);
  public settings = {
    answerTimeout: 20000,
    finalTimeout: 30000,
    host: undefined as string | undefined,
    allowMultipleCorrect: false,
    enableAIJudge: false,
    enableAIVoices: undefined as string | undefined,
  };

  // Unserialized state
  private io: Server;
  public roomId: string;
  // Note: snapshot is not persisted so undo is not possible if server restarts
  private jpdSnapshot: ReturnType<typeof getGameState> | undefined;
  private undoActivated: boolean | undefined = undefined;
  private aiJudged: boolean | undefined = undefined;
  private playClueTimeout: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
  private questionAnswerTimeout: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
  private wagerTimeout: NodeJS.Timeout = undefined as unknown as NodeJS.Timeout;
  public cleanupInterval: NodeJS.Timeout = undefined as unknown as NodeJS.Timeout;
  public lastUpdateTime: Date = new Date();

  constructor(
    io: Server,
    roomId: string,
    roomData?: string | null | undefined,
  ) {
    this.io = io;
    this.roomId = roomId;

    if (roomData) {
      this.deserialize(roomData);
    }

    this.cleanupInterval = setInterval(() => {
      // Remove players that have been disconnected for a long time
      const beforeLength = this.getAllPlayers();
      const now = Date.now();
      this.roster = this.roster.filter(
        (p) => p.connected || now - p.disconnectTime < 60 * 60 * 1000,
      );
      const afterLength = this.getAllPlayers();
      if (beforeLength !== afterLength && this.getConnectedPlayers().length > 0) {
        this.sendRoster();
      }
    }, 30 * 60 * 1000);

    io.of(roomId).on('connection', (socket: Socket) => {
      this.jpd.public.scores[socket.id] = 0;

      const clientId = socket.handshake.query?.clientId as string;
      // clientid map keeps track of the unique clients we've seen
      // if we saw this ID already, do the reconnect logic (transfer state)
      // The list is persisted, so if the server reboots, all clients reconnect and should have state restored
      if (this.clientIds[clientId]) {
        const newId = socket.id;
        const oldId = this.clientIds[clientId];
        this.handleReconnect(newId, oldId);
      }
      if (!this.getAllPlayers().find((p) => p.id === socket.id)) {
        // New client joining, add to roster
        this.roster.push({
          id: socket.id,
          name: undefined,
          connected: true,
          disconnectTime: 0,
        });
      }
      this.clientIds[clientId] = socket.id;

      this.sendState();
      this.sendRoster();
      socket.emit('chatinit', this.chat);

      socket.on('CMD:name', (data: string) => {
        if (!data) {
          return;
        }
        if (data && data.length > 100) {
          return;
        }
        const target = this.getAllPlayers().find((p) => p.id === socket.id);
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
        if (this.settings.host && socket.id !== this.settings.host) {
          return;
        }
        if (
          this.jpd.public.picker &&
          // If the picker is disconnected, allow anyone to pick to avoid blocking game
          this.getConnectedPlayers().find(
            (p) => p.id === this.jpd.public.picker,
          ) &&
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
        if (this.jpd.board[id].dd && !this.settings.allowMultipleCorrect) {
          // if it is, don't show it yet, we need to collect wager info based only on category
          this.jpd.public.currentDailyDouble = true;
          this.jpd.public.dailyDoublePlayer = socket.id;
          this.jpd.public.waitingForWager = { [socket.id]: true };
          this.setWagerTimeout(this.settings.answerTimeout);
          // Autobuzz the player who picked the DD, all others pass
          // Note: if a player joins during wagering, they might not be marked as passed (submitted)
          // Currently client doesn't show the answer box because it checks for buzzed in players
          // But there's probably no server block on them submitting answers
          this.getActivePlayers().forEach((p) => {
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
        this.aiJudged = undefined;
        this.sendState();
      });
      socket.on('JPD:buzz', () => {
        if (!this.jpd.public.canBuzz) {
          return;
        }
        if (this.jpd.public.buzzes[socket.id]) {
          return;
        }
        this.jpd.public.buzzes[socket.id] = Date.now();
        this.sendState();
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
        this.sendState();
        if (
          this.jpd.public.round !== 'final' &&
          // If a player disconnects, don't wait for their answer
          this.getConnectedPlayers().every(
            (p) => p.id in this.jpd.public.submitted,
          )
        ) {
          this.revealAnswer();
        }
      });

      socket.on('JPD:wager', (wager) => this.submitWager(socket.id, wager));
      socket.on('JPD:judge', (data) => this.doHumanJudge(socket, data));
      socket.on('JPD:bulkJudge', (data) => {
        // Check if the next player to be judged is in the input data
        // If so, doJudge for that player
        // Check if we advanced to the next question, otherwise keep doing 
        let count = 0;
        while (this.jpd.public.currentJudgeAnswer !== undefined && count <= data.length) {
          // The bulkjudge may not contain all decisions. Stop if we did as many decisions as the input data
          console.log('[BULKJUDGE]', count, data.length);
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
        if (this.settings.host && socket.id !== this.settings.host) {
          // Not the host
          return;
        }
        // Reset the game state to the last snapshot
        // Snapshot updates at each revealAnswer
        if (this.jpdSnapshot) {
          redisCount('undo');
          if (this.aiJudged) {
            redisCount('aiUndo');
            this.aiJudged = undefined;
          }
          this.undoActivated = true;
          this.jpd = JSON.parse(JSON.stringify(this.jpdSnapshot));
          this.advanceJudging(false);
          this.sendState();
        }
      });
      socket.on('JPD:skipQ', () => {
        if (this.jpd.public.canNextQ) {
          // We are in the post-judging phase and can move on
          this.nextQuestion();
        }
      });
      socket.on('JPD:enableAiJudge', (enable: boolean) => {
        this.settings.enableAIJudge = Boolean(enable);
        this.sendState();
        // optional: If we're in the judging phase, trigger the AI judge here
        // That way we can decide to use AI judge after the first answer has already been revealed
      });
      socket.on('CMD:chat', (data: string) => {
        if (data && data.length > 10000) {
          // TODO add some validation on client side too so we don't just drop long messages
          return;
        }
        if (data === '/clear') {
          this.chat.length = 0;
          io.of(roomId).emit('chatinit', this.chat);
          return;
        }
        if (data.startsWith('/aivoices')) {
          const rvcServer =
            data.split(' ')[1] ?? 'https://azure.howardchung.net/rvc';
          this.pregenAIVoices(rvcServer);
        }
        const sender = this.getAllPlayers().find((p) => p.id === socket.id);
        const chatMsg = { id: socket.id, name: sender?.name, msg: data };
        this.addChatMessage(socket, chatMsg);
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
        let target = this.getAllPlayers().find((p) => p.id === socket.id);
        if (target) {
          target.connected = false;
          target.disconnectTime = Date.now();
        }
        this.sendRoster();
      });
    });
  }

  serialize = () => {
    return JSON.stringify({
      chat: this.chat,
      clientIds: this.clientIds,
      roster: this.roster,
      creationTime: this.creationTime,
      jpd: this.jpd,
      settings: this.settings,
    });
  };

  deserialize = (roomData: string) => {
    const roomObj = JSON.parse(roomData);
    if (roomObj.chat) {
      this.chat = roomObj.chat;
    }
    if (roomObj.clientIds) {
      this.clientIds = roomObj.clientIds;
    }
    if (roomObj.creationTime) {
      this.creationTime = new Date(roomObj.creationTime);
    }
    if (roomObj.roster) {
      // Reset connected state to false, reconnects will update it again
      this.roster = roomObj.roster.map((p: User) => ({...p, connected: false}));
    }
    if (roomObj.jpd && roomObj.jpd.public) {
      const gameData = roomObj.jpd;
      this.jpd = gameData;
      // Reconstruct the timeouts from the saved state
      if (this.jpd.public.questionEndTS) {
        const remaining = this.jpd.public.questionEndTS - Date.now();
        this.setQuestionAnswerTimeout(remaining);
      }
      if (this.jpd.public.playClueEndTS) {
        const remaining = this.jpd.public.playClueEndTS - Date.now();
        this.setPlayClueTimeout(remaining);
      }
      if (this.jpd.public.wagerEndTS) {
        const remaining = this.jpd.public.wagerEndTS - Date.now();
        this.setWagerTimeout(remaining, this.jpd.public.wagerEndTS);
      }
    }
    if (roomObj.settings) {
      this.settings = roomObj.settings;
    }
  };

  saveRoom = async () => {
    const roomData = this.serialize();
    const key = this.roomId;
    await redis?.setex(key, 24 * 60 * 60, roomData);
    if (config.permaRooms.includes(key)) {
      await redis?.persist(key);
    }
    this.lastUpdateTime = new Date();
    redisCount('saves');
  }

  addChatMessage = (socket: Socket | undefined, chatMsg: any) => {
    const chatWithTime: ChatMessage = {
      ...chatMsg,
      timestamp: new Date().toISOString(),
    };
    this.chat.push(chatWithTime);
    this.chat = this.chat.splice(-100);
    this.io.of(this.roomId).emit('REC:chat', chatWithTime);
    this.saveRoom();
  };
  
  sendState = () => {
    this.jpd.public.serverTime = Date.now();
    // Copy values over from settings before each send
    this.jpd.public.host = this.settings.host;
    this.jpd.public.enableAIJudge = this.settings.enableAIJudge;
    this.jpd.public.enableAIVoices = this.settings.enableAIVoices;
    this.io.of(this.roomId).emit('JPD:state', this.jpd.public);
    this.saveRoom();
  }

  sendRoster = () => {
    // Sort by score and resend the list of players to everyone
    this.roster.sort(
      (a, b) =>
        (this.jpd.public?.scores[b.id] || 0) -
        (this.jpd.public?.scores[a.id] || 0),
    );
    this.io.of(this.roomId).emit('roster', this.roster);
    this.saveRoom();
  }

  getConnectedPlayers = () => {
    // Returns players that are currently connected and not spectators
    return this.roster.filter((p) => p.connected);
  };

  getActivePlayers = () => {
    // Returns all players not marked as spectator (includes disconnected)
    // Currently just returns all players
    // In the future we might want to ignore spectators
    return this.roster;
  };

  getAllPlayers = () => {
    // Return all players regardless of connection state or spectator
    return this.roster;
  };

  handleReconnect = (newId: string, oldId: string) => {
    console.log('[RECONNECT] transfer %s to %s', oldId, newId);
    // Update the roster with the new ID and connected state
    const target = this.getAllPlayers().find((p) => p.id === oldId);
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
    if (this.settings.host === oldId) {
      this.settings.host = newId;
    }
  }

  loadEpisode = (socket: Socket, options: GameOptions, custom: string) => {
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
        const parse = Papa.parse<any>(custom, { header: true });
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
      const jData = getJData();
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
        },
        jeopardy,
        double,
        final,
      );
      this.jpdSnapshot = undefined;
      this.settings.host = makeMeHost ? socket.id : undefined;
      if (allowMultipleCorrect) {
        this.settings.allowMultipleCorrect = allowMultipleCorrect;
      }
      if (enableAIJudge) {
        this.settings.enableAIJudge = enableAIJudge;
      }
      if (Number(finalTimeout)) {
        this.settings.finalTimeout = Number(finalTimeout) * 1000;
      }
      if (Number(answerTimeout)) {
        this.settings.answerTimeout = Number(answerTimeout) * 1000;
      }
      if (number === 'finaltest') {
        this.jpd.public.round = 'double';
      }
      this.nextRound();
    }
  }

  playCategories = () => {
    this.io.of(this.roomId).emit('JPD:playCategories');
  }

  resetAfterQuestion = () => {
    this.jpd.answers = {};
    this.jpd.wagers = {};
    clearTimeout(this.playClueTimeout);
    clearTimeout(this.questionAnswerTimeout);
    clearTimeout(this.wagerTimeout);
    this.jpd.public = { ...this.jpd.public, ...getPerQuestionState() };
    // Overwrite any other picker settings if there's a host
    if (this.settings.host) {
      this.jpd.public.picker = this.settings.host;
    }
  }

  nextQuestion = () => {
    // Show the correct answer in the game log
    this.addChatMessage(undefined, {
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
      this.sendState();
      // TODO may want to introduce some delay here to make sure our state is updated before reading selection
      this.io.of(this.roomId).emit('JPD:playMakeSelection');
    }
  }

  nextRound = () => {
    this.resetAfterQuestion();
    // host is made picker in resetAfterQuestion, so any picker changes here should be behind host check
    // advance round counter
    if (this.jpd.public.round === 'jeopardy') {
      this.jpd.public.round = 'double';
      // If double, person with lowest score is picker
      // Unless we are allowing multiple corrects or there's a host
      if (!this.settings.allowMultipleCorrect && !this.settings.host) {
        // Pick the lowest score out of the currently connected players
        // This is nlogn rather than n, but prob ok for small numbers of players
        const playersWithScores = this.getConnectedPlayers().map((p) => ({
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
      // There's no picker for final. In host mode we set one above
      this.jpd.public.picker = undefined;
      // Ask all players for wager (including disconnected since they might come back)
      this.getActivePlayers().forEach((p) => {
        this.jpd.public.waitingForWager![p.id] = true;
      });
      this.setWagerTimeout(this.settings.finalTimeout);
      // autopick the question
      this.jpd.public.currentQ = '1_1';
      // autobuzz the players in ascending score order
      let playerIds = this.getActivePlayers().map((p) => p.id);
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
        this.getAllPlayers().find((p) => p.id === score[0])?.name,
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
    this.sendState();
    if (
      this.jpd.public.round === 'jeopardy' ||
      this.jpd.public.round === 'double'
    ) {
      this.playCategories();
    }
  }

  unlockAnswer = (durationMs: number) => {
    this.jpd.public.questionEndTS = Date.now() + durationMs;
    this.setQuestionAnswerTimeout(durationMs);
  }

  setQuestionAnswerTimeout = (durationMs: number) => {
    this.questionAnswerTimeout = setTimeout(() => {
      if (this.jpd.public.round !== 'final') {
        this.io.of(this.roomId).emit('JPD:playTimesUp');
      }
      this.revealAnswer();
    }, durationMs);
  }

  revealAnswer = () => {
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
    this.sendState();
  }

  advanceJudging = (skipRemaining: boolean) => {
    if (this.jpd.public.currentJudgeAnswerIndex === undefined) {
      this.jpd.public.currentJudgeAnswerIndex = 0;
    } else {
      this.jpd.public.currentJudgeAnswerIndex += 1;
    }
    this.jpd.public.currentJudgeAnswer = Object.keys(this.jpd.public.buzzes)[
      this.jpd.public.currentJudgeAnswerIndex
    ];
    // Either we picked a correct answer (in standard mode) or ran out of players to judge
    if (skipRemaining || this.jpd.public.currentJudgeAnswer === undefined) {
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
      !this.getActivePlayers().find(
        (p) => p.id === this.jpd.public.currentJudgeAnswer,
      )
    ) {
      console.log(
        '[ADVANCEJUDGING] player not found, moving on:',
        this.jpd.public.currentJudgeAnswer,
      );
      this.advanceJudging(skipRemaining);
      return;
    }
    if (
      openai &&
      !this.jpd.public.canNextQ &&
      this.settings.enableAIJudge &&
      // Don't use AI if the user undid
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

  doAiJudge = async (data: { currentQ: string; id: string }) => {
    // count the number of automatic judges
    redisCount('aiJudge');
    // currentQ: The board coordinates of the current question, e.g. 1_3
    // id: socket id of the person being judged
    const { currentQ, id } = data;
    // The question text
    const q = this.jpd.board[currentQ]?.q ?? '';
    const a = this.jpd.public.currentAnswer ?? '';
    const response = this.jpd.public.answers[id];
    let correct: boolean | null = null;
    if (response === '') {
      // empty response is always wrong
      correct = false;
      redisCount('aiShortcut');
    } else if (response.toLowerCase().trim() === a.toLowerCase().trim()) {
      // exact match is always right
      correct = true;
      redisCount('aiShortcut');
    } else {
      // count the number of calls to chatgpt
      redisCount('aiChatGpt');
      try {
        const decision = await getOpenAIDecision(q, a, response);
        console.log('[AIDECISION]', id, q, a, response, decision);
        if (decision && decision.correct != null) {
          correct = decision.correct;
        } else {
          redisCount('aiRefuse');
        }
        // Log the AI decision to measure accuracy
        // If the user undoes and then chooses differently than AI, then that's a failed decision
        // Alternative: we can just highlight what the AI thinks is correct instead of auto-applying the decision, then we'll have user feedback for sure
        // If undefined, AI refused to answer
        redis?.lpush(
          'jpd:aiJudges',
          JSON.stringify({ q, a, response, correct: decision?.correct }),
        );
        redis?.ltrim('jpd:aiJudges', 0, 1000);
      } catch (e) {
        console.log(e);
      }
    }
    if (correct != null) {
      this.judgeAnswer(undefined, { currentQ, id, correct });
    }
  }

  doHumanJudge = (
    socket: Socket,
    data: { currentQ: string; id: string; correct: boolean | null },
  ) => {
    const success = this.judgeAnswer(socket, data);
  }

  judgeAnswer = (
    socket: Socket | undefined,
    {
      currentQ,
      id,
      correct,
      confidence,
    }: {
      currentQ: string;
      id: string;
      correct: boolean | null;
      confidence?: number;
    },
  ) => {
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
    if (this.settings.host && socket && socket?.id !== this.settings.host) {
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
      if (!this.settings.allowMultipleCorrect) {
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
          this.getAllPlayers().find((p) => p.id === socket?.id)?.name ??
          'System',
        cmd: 'judge',
        msg: JSON.stringify({
          id: id,
          // name of person being judged
          name: this.getAllPlayers().find((p) => p.id === id)?.name,
          answer: this.jpd.public.answers[id],
          correct,
          delta: correct ? delta : -delta,
          confidence,
        }),
      };
      this.addChatMessage(socket, msg);
      if (!socket) {
        this.aiJudged = true;
      }
    }
    const allowMultipleCorrect =
      this.jpd.public.round === 'final' || this.settings.allowMultipleCorrect;
    const skipRemaining = !allowMultipleCorrect && correct === true;
    this.advanceJudging(skipRemaining);

    if (this.jpd.public.canNextQ) {
      this.nextQuestion();
    } else {
      this.sendState();
    }
    return correct != null;
  }

  submitWager = (id: string, wager: number) => {
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
      this.sendState();
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
      this.sendState();
    }
  }

  setWagerTimeout = (durationMs: number, endTS?: number) => {
    this.jpd.public.wagerEndTS = endTS ?? Date.now() + durationMs;
    this.wagerTimeout = setTimeout(() => {
      Object.keys(this.jpd.public.waitingForWager ?? {}).forEach((id) => {
        this.submitWager(id, 0);
      });
    }, durationMs);
  }

  triggerPlayClue = () => {
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

  setPlayClueTimeout = (durationMs: number) => {
    this.playClueTimeout = setTimeout(() => {
      this.playClueDone();
    }, durationMs);
  }

  playClueDone = () => {
    clearTimeout(this.playClueTimeout);
    this.jpd.public.playClueEndTS = 0;
    this.jpd.public.buzzUnlockTS = Date.now();
    if (this.jpd.public.round === 'final') {
      this.unlockAnswer(this.settings.finalTimeout);
      // Play final jeopardy music
      this.io.of(this.roomId).emit('JPD:playFinalJeopardy');
    } else {
      if (!this.jpd.public.currentDailyDouble) {
        // DD already handles buzzing automatically
        this.jpd.public.canBuzz = true;
      }
      this.unlockAnswer(this.settings.answerTimeout);
    }
    this.sendState();
  }

  pregenAIVoices = async (rvcHost: string) => {
    // Indicate we should use AI voices for this game
    this.settings.enableAIVoices = rvcHost;
    this.sendState();
    // For the current game, get all category names and clues (61 clues + 12 category names)
    // Final category doesn't get read right now
    const strings = new Set(
      [
        ...(this.jpd.jeopardy?.map((item) => item.q) ?? []),
        ...(this.jpd.double?.map((item) => item.q) ?? []),
        ...(this.jpd.final?.map((item) => item.q) ?? []),
        ...(this.jpd.jeopardy?.map((item) => item.cat) ?? []),
        ...(this.jpd.double?.map((item) => item.cat) ?? []),
      ].filter(Boolean),
    );
    console.log('%s strings to generate', strings.size);
    const items = Array.from(strings);
    const start = Date.now();
    let cursor = items.entries();
    // create for loops that each run off the same cursor which keeps track of location
    let numWorkers = 10;
    // The parallelism should ideally depend on the server configuration
    // But we just need a value that won't take more than 5 minutes between start and stop because fetch will timeout
    // No good way of configuring it right now without switching to undici
    let success = 0;
    let count = 0;
    Array(numWorkers).fill('').forEach(async (_, workerIndex) => {
      for (let [i, text] of cursor) {
        try {
          const url = await genAITextToSpeech(rvcHost, text ?? '');
          // Report progress back in chat messages
          if (url) {
            this.addChatMessage(undefined, {
              id: '',
              name: 'System',
              msg: 'generated ai voice ' + i + ': ' + url,
            });
            redisCount('aiVoice');
            success += 1;
          }
        } catch (e) {
          // Log errors, but continue iterating
          console.log(e);
        }
        count += 1;
      }
      if (count === items.length) {
        const end = Date.now();
        this.addChatMessage(undefined, {
          id: '',
          name: 'System',
          msg:
            success +
            '/' +
            count +
            ' voices generated in ' + (end - start) + 'ms',
        });
      }
    });
  }
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
