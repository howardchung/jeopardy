import { Socket, Server } from "socket.io";
import Papa from "papaparse";
import { redis, redisCount } from "./redis.ts";
import { genAITextToSpeech } from "./aivoice.ts";
import { getOpenAIDecision, openai } from "./openai.ts";
import config from "./config.ts";
import { getGameState, getPerQuestionState } from "./gamestate.ts";
import { getJData } from "./jData.ts";

export class Room {
  // Serialized state
  public roster: User[] = [];
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
  public cleanupInterval: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
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

    this.cleanupInterval = setInterval(
      () => {
        // Remove players that have been disconnected for a long time
        // NOTE: If we're waiting to judge this player's answer, removing them will block the game from continuing
        // Waiting for wager is OK because we automatically move on after timeout
        const beforeLength = this.roster.length;
        const now = Date.now();
        this.roster = this.roster.filter(
          (p) =>
            p.connected ||
            p.id in this.jpd.public.answers ||
            now - p.disconnectTime < 60 * 60 * 1000,
        );
        const afterLength = this.roster.length;
        if (beforeLength !== afterLength) {
          this.sendRoster();
        }
      },
      10 * 60 * 1000,
    );

    io.of(roomId).on("connection", (socket: Socket) => {
      // We use the clientId for game state
      // This avoids potentially unreliable reconnection issues since socket.id changes on each reconnection
      // TODO We should probably validate that a reconnecting player is who they say they are (maybe via a private sessionID passed on initial connection?)
      // Otherwise a malicious user can spoof as another player (but we kind of trust the players anyway for judging)
      const clientId = socket.handshake.query?.clientId;
      if (typeof clientId !== "string") {
        socket.disconnect();
        return;
      }
      if (!isValidUUID(clientId)) {
        // Prevent prototype pollution since clientId is user input by validating UUID
        socket.disconnect();
        return;
      }

      // Add to roster, or update if they're just reconnecting
      const existingIndex = this.roster.findIndex((p) => p.id === clientId);
      if (existingIndex === -1) {
        // New client joining, add to roster
        this.roster.push({
          id: clientId,
          name: undefined,
          connected: true,
          disconnectTime: 0,
          spectator: false,
        });
        this.jpd.public.scores[clientId] = 0;
      } else {
        // Reconnecting user
        if (!this.roster[existingIndex].connected) {
          this.roster[existingIndex].connected = true;
          this.roster[existingIndex].disconnectTime = 0;
        } else {
          // User with this client ID already connected? Either collision (unlikely) or trying to spoof
          socket.disconnect();
          return;
        }
      }

      this.sendState();
      this.sendRoster();
      socket.emit("chatinit", this.chat);

      socket.on("CMD:name", (raw: unknown) => {
        const data = String(raw);
        if (!data) {
          return;
        }
        if (data && data.length > 50) {
          return;
        }
        const targetIndex = this.roster.findIndex((p) => p.id === clientId);
        if (targetIndex >= 0) {
          this.roster[targetIndex].name = data;
          this.sendRoster();
        }
      });
      socket.on("JPD:spectate", (raw: unknown) => {
        const spectate = Boolean(raw);
        const targetIndex = this.roster.findIndex((p) => p.id === clientId);
        if (targetIndex >= 0) {
          this.roster[targetIndex].spectator = Boolean(spectate);
          this.sendRoster();
        }
      });
      // socket.on('JPD:cmdIntro', () => {
      //   this.io.of(this.roomId).emit('JPD:playIntro');
      // });
      socket.on("JPD:start", (raw: unknown, raw2: unknown) => {
        const options = (raw ?? {}) as GameOptions;
        const data = raw2 ? String(raw2) : "";
        if (data && data.length > 1000000) {
          return;
        }
        if (typeof options !== "object") {
          return;
        }
        this.loadEpisode(clientId, options, data);
      });
      socket.on("JPD:pickQ", (raw: unknown) => {
        const id = String(raw);
        if (this.settings.host && clientId !== this.settings.host) {
          // Not the host
          return;
        }
        if (this.isSpectator(clientId)) {
          // Don't allow spectators to pick (avoid them getting daily doubles)
          return;
        }
        if (
          this.jpd.public.picker &&
          // Only allow designated picker to pick
          // If they're disconnected or spectating or gone, skip check to avoid blocking game
          this.getActivePlayers().find((p) => p.id === this.jpd.public.picker)
            ?.connected &&
          this.jpd.public.picker !== clientId
        ) {
          return;
        }
        if (this.jpd.public.currentQ) {
          return;
        }
        if (!this.jpd.public.board[id]) {
          return;
        }
        // Undo no longer possible after next question is picked
        this.jpdSnapshot = undefined;
        this.undoActivated = undefined;
        this.aiJudged = undefined;
        this.jpd.public.currentQ = id;
        this.jpd.public.currentValue = this.jpd.public.board[id].value;
        // check if it's a daily double
        if (this.jpd.board[id].dd && !this.settings.allowMultipleCorrect) {
          // if it is, don't show it yet, we need to collect wager info based only on category
          this.jpd.public.currentDailyDouble = true;
          this.jpd.public.dailyDoublePlayer = clientId;
          this.jpd.public.waitingForWager = { [clientId]: true };
          this.setWagerTimeout(this.settings.answerTimeout);
          // Autobuzz the player who picked the DD, all others pass
          // Note: if a player joins during wagering, they might not be marked as passed (submitted)
          // Currently client doesn't show the answer box because it checks for buzzed in players
          // But there's probably no server block on them submitting answers
          this.getActivePlayers().forEach((p) => {
            if (p.id === clientId) {
              this.jpd.public.buzzes[p.id] = Date.now();
            } else {
              this.jpd.public.submitted[p.id] = true;
            }
          });
          this.io.of(this.roomId).emit("JPD:playDailyDouble");
          this.sendState();
        } else {
          // Put Q in public state
          this.revealQuestion();
        }
      });
      socket.on("JPD:buzz", () => {
        if (!this.jpd.public.canBuzz) {
          return;
        }
        if (this.isSpectator(clientId)) {
          // Don't allow spectators to buzz
          return;
        }
        if (this.jpd.public.buzzes[clientId]) {
          return;
        }
        this.jpd.public.buzzes[clientId] = Date.now();
        this.sendState();
      });
      socket.on("JPD:answer", (raw1: unknown, raw2: unknown) => {
        const question = String(raw1);
        const answer = raw2 ? String(raw2) : "";
        if (question !== this.jpd.public.currentQ) {
          // Not submitting for right question
          return;
        }
        if (!this.jpd.public.questionEndTS) {
          // Time was already up
          return;
        }
        if (answer && answer.length > 1000) {
          // Answer too long
          return;
        }
        if (this.isSpectator(clientId)) {
          // Don't allow spectators to answer
          return;
        }
        if (this.jpd.public.submitted[clientId]) {
          // Answer was already submitted
          return;
        }
        if (answer) {
          this.jpd.answers[clientId] = answer;
        }
        this.jpd.public.submitted[clientId] = true;
        this.sendState();
        if (
          // In final, we always wait the full designated time
          this.jpd.public.round !== "final" &&
          // Otherwise if all connected players have submitted, move on
          this.getActivePlayers().every(
            (p) => p.id in this.jpd.public.submitted || !p.connected,
          )
        ) {
          this.revealAnswer();
        }
      });

      socket.on("JPD:wager", (raw: unknown) => {
        const wager = Number(raw);
        if (this.isSpectator(clientId)) {
          // Don't allow spectators to wager
          return;
        }
        this.submitWager(clientId, wager);
      });
      socket.on("JPD:judge", (raw: unknown) => {
        if (this.settings.host && clientId !== this.settings.host) {
          // Not the host
          return;
        }
        if (this.isSpectator(clientId)) {
          return;
        }
        this.doHumanJudge(clientId, raw);
      });
      socket.on("JPD:undo", () => {
        if (this.settings.host && clientId !== this.settings.host) {
          // Not the host
          return;
        }
        if (this.isSpectator(clientId)) {
          return;
        }
        // Reset the game state to the last snapshot
        // Snapshot updates at each revealAnswer
        if (this.jpdSnapshot) {
          redisCount("undo");
          if (this.aiJudged) {
            redisCount("aiUndo");
            this.aiJudged = undefined;
          }
          this.undoActivated = true;
          this.jpd = JSON.parse(JSON.stringify(this.jpdSnapshot));
          this.advanceJudging(false);
          this.sendState();
        }
      });
      socket.on("JPD:skipQ", () => {
        if (this.jpd.public.canNextQ) {
          // We are in the post-judging phase and can move on
          this.nextQuestion();
        }
      });
      socket.on("JPD:enableAiJudge", (raw: unknown) => {
        this.settings.enableAIJudge = Boolean(raw);
        this.sendState();
        // optional: If we're in the judging phase, trigger the AI judge here
        // That way we can decide to use AI judge after the first answer has already been revealed
      });
      socket.on("CMD:chat", (raw: unknown) => {
        const data = String(raw);
        if (data && data.length > 5000) {
          // TODO add some validation on client side too so we don't just drop long messages
          return;
        }
        if (data === "/clear") {
          this.chat.length = 0;
          io.of(roomId).emit("chatinit", this.chat);
          return;
        }
        if (data.startsWith("/aivoices")) {
          const rvcServer =
            data.split(" ")[1] ?? "https://azure.howardchung.net/rvc";
          this.pregenAIVoices(rvcServer);
        }
        const sender = this.roster.find((p) => p.id === clientId);
        const chatMsg = { id: clientId, name: sender?.name, msg: data };
        this.addChatMessage(chatMsg);
      });
      socket.on("disconnect", () => {
        // Mark the user disconnected
        let targetIndex = this.roster.findIndex((p) => p.id === clientId);
        if (targetIndex >= 0) {
          this.roster[targetIndex].connected = false;
          this.roster[targetIndex].disconnectTime = Date.now();
        }
        this.sendRoster();
      });
    });
  }

  serialize = () => {
    return JSON.stringify({
      chat: this.chat,
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
    if (roomObj.creationTime) {
      this.creationTime = new Date(roomObj.creationTime);
    }
    if (roomObj.roster) {
      // Reset connected state to false, reconnects will update it again
      this.roster = roomObj.roster.map((p: User) => ({
        ...p,
        connected: false,
      }));
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
    redisCount("saves");
  };

  addChatMessage = (chatMsg: any) => {
    const chatWithTime: ChatMessage = {
      ...chatMsg,
      timestamp: new Date().toISOString(),
    };
    this.chat.push(chatWithTime);
    this.chat = this.chat.splice(-100);
    this.io.of(this.roomId).emit("REC:chat", chatWithTime);
    this.saveRoom();
  };

  sendState = () => {
    this.jpd.public.serverTime = Date.now();
    // Copy values over from settings before each send
    this.jpd.public.host = this.settings.host;
    this.jpd.public.enableAIJudge = this.settings.enableAIJudge;
    this.jpd.public.enableAIVoices = this.settings.enableAIVoices;
    this.io.of(this.roomId).emit("JPD:state", this.jpd.public);
    this.saveRoom();
  };

  sendRoster = () => {
    // Sort by score and resend the list of players to everyone
    this.roster.sort(
      (a, b) =>
        (this.jpd.public?.scores[b.id] || 0) -
        (this.jpd.public?.scores[a.id] || 0),
    );
    this.io.of(this.roomId).emit("roster", this.roster);
    this.saveRoom();
  };

  getActivePlayers = () => {
    // Returns all players not marked as spectator (includes disconnected)
    return this.roster.filter((p) => !p.spectator);
  };

  isSpectator = (id: string) => {
    return this.roster.find((p) => p.id === id)?.spectator;
  };

  loadEpisode = (clientId: string, options: GameOptions, custom: string) => {
    let {
      number,
      filter,
      answerTimeout,
      finalTimeout,
      makeMeHost,
      allowMultipleCorrect,
    } = options;
    console.log("[LOADEPISODE]", number, filter, Boolean(custom));
    let loadedData = null;
    if (custom) {
      try {
        const parse = Papa.parse<any>(custom, { header: true });
        const typed = [];
        let round = "start";
        let cat = "";
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
          if (round === "double") {
            multiplier = 2;
          } else if (round === "triple") {
            multiplier = 3;
          } else if (round === "final") {
            multiplier = 0;
          }
          if (d.q && d.a) {
            typed.push({
              round: d.round,
              cat: d.cat,
              q: d.q,
              a: d.a,
              dd: d.dd?.toLowerCase() === "true",
              val: curY * 200 * multiplier,
              x: curX,
              y: curY,
            });
          }
        }
        loadedData = {
          airDate: new Date().toISOString().split("T")[0],
          epNum: "Custom",
          jeopardy: typed.filter((d: any) => d.round === "jeopardy"),
          double: typed.filter((d: any) => d.round === "double"),
          triple: typed.filter((d: any) => d.round === "triple"),
          final: typed.filter((d: any) => d.round === "final"),
        };
        redisCount("customGames");
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
          (num) => jData[num].info && jData[num].info === filter,
        );
      }
      if (number === "ddtest") {
        loadedData = { ...jData["8000"] };
        loadedData["jeopardy"] = loadedData["jeopardy"]?.filter(
          (q: any) => q.dd,
        );
        loadedData["double"] = loadedData["double"]?.filter((q: any) => q.dd);
      } else if (number === "tripletest") {
        loadedData = { ...jData["pcj_1"] };
        loadedData["jeopardy"] = loadedData["jeopardy"]?.filter(
          (q: any) => q.dd,
        );
        loadedData["double"] = loadedData["double"]?.slice(0, 1);
        loadedData["triple"] = loadedData["triple"]?.slice(0, 1);
      } else if (number === "finaltest") {
        loadedData = { ...jData["8000"] };
        loadedData.jeopardy = [];
        loadedData.double = [];
      } else {
        if (!number) {
          // Random an episode
          number = nums[Math.floor(Math.random() * nums.length)];
        }
        loadedData = jData[number];
      }
    }
    if (loadedData) {
      redisCount("newGames");
      const { epNum, airDate, info, jeopardy, double, triple, final } =
        loadedData;
      this.jpd = getGameState(
        {
          epNum,
          airDate,
          info,
        },
        jeopardy,
        double,
        triple,
        final,
      );
      this.jpdSnapshot = undefined;
      this.settings.host = makeMeHost ? clientId : undefined;
      this.settings.allowMultipleCorrect = Boolean(allowMultipleCorrect);
      if (Number(finalTimeout)) {
        this.settings.finalTimeout = Number(finalTimeout) * 1000;
      }
      if (Number(answerTimeout)) {
        this.settings.answerTimeout = Number(answerTimeout) * 1000;
      }
      this.nextRound();
    }
  };

  playCategories = () => {
    this.io.of(this.roomId).emit("JPD:playCategories");
  };

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
  };

  nextQuestion = () => {
    // Show the correct answer in the game log
    this.addChatMessage({
      id: "",
      name: "System",
      cmd: "answer",
      msg: this.jpd.public.currentAnswer,
      bot: true,
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
      this.io.of(this.roomId).emit("JPD:playMakeSelection");
    }
  };

  nextRound = () => {
    this.resetAfterQuestion();
    // host is made picker in resetAfterQuestion, so any picker changes here should be behind host check
    // advance round counter
    if (
      this.jpd.public.round === "jeopardy" ||
      this.jpd.public.round === "double"
    ) {
      if (this.jpd.public.round === "jeopardy") {
        this.jpd.public.round = "double";
      } else if (this.jpd.public.round === "double") {
        this.jpd.public.round = "triple";
      }
      // If double, person with lowest score is picker
      // Unless we are allowing multiple corrects or there's a host
      if (!this.settings.allowMultipleCorrect && !this.settings.host) {
        // Pick the lowest score out of the active players
        // This is nlogn rather than n, but prob ok for small numbers of players
        const playersWithScores = this.getActivePlayers().map((p) => ({
          id: p.id,
          score: this.jpd.public.scores[p.id] || 0,
        }));
        playersWithScores.sort((a, b) => a.score - b.score);
        this.jpd.public.picker = playersWithScores[0]?.id;
      }
    } else if (this.jpd.public.round === "triple") {
      this.jpd.public.round = "final";
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
      this.jpd.public.currentQ = "1_1";
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
      this.io.of(this.roomId).emit("JPD:playRightanswer");
    } else if (this.jpd.public.round === "final") {
      this.jpd.public.round = "end";
      // Log the results
      const scores = Object.entries(this.jpd.public.scores);
      scores.sort((a, b) => b[1] - a[1]);
      const scoresNames = scores.map((score) => [
        this.roster.find((p) => p.id === score[0])?.name,
        score[1],
      ]);
      redis?.lpush("jpd:results", JSON.stringify(scoresNames));
    } else {
      this.jpd.public.round = "jeopardy";
    }
    if (this.jpd.public.round !== "end") {
      this.jpd.board = constructBoard(this.jpd[this.jpd.public.round] ?? []);
      this.jpd.public.board = constructPublicBoard(
        this.jpd[this.jpd.public.round] ?? [],
      );
      if (Object.keys(this.jpd.public.board).length === 0) {
        this.nextRound();
      }
    }
    this.sendState();
    if (this.jpd.public.round !== "final" && this.jpd.public.round !== "end") {
      this.playCategories();
    }
  };

  unlockAnswer = (durationMs: number) => {
    this.jpd.public.questionEndTS = Date.now() + durationMs;
    this.setQuestionAnswerTimeout(durationMs);
  };

  setQuestionAnswerTimeout = (durationMs: number) => {
    this.questionAnswerTimeout = setTimeout(() => {
      if (this.jpd.public.round !== "final") {
        this.io.of(this.roomId).emit("JPD:playTimesUp");
      }
      this.revealAnswer();
    }, durationMs);
  };

  revealAnswer = () => {
    clearTimeout(this.questionAnswerTimeout);
    this.jpd.public.questionEndTS = 0;

    // Add empty answers for anyone who buzzed but didn't submit anything
    Object.keys(this.jpd.public.buzzes).forEach((key) => {
      if (!this.jpd.answers[key]) {
        this.jpd.answers[key] = "";
      }
    });
    this.jpd.public.canBuzz = false;
    // Show everyone's answers and wagers
    this.jpd.public.answers = { ...this.jpd.answers };
    this.jpd.public.wagers = { ...this.jpd.wagers };
    this.jpd.public.currentAnswer = this.jpd.board[this.jpd.public.currentQ]?.a;
    // Set up the queue to judge, ordered by buzz time
    this.jpd.public.judgeArr = Object.keys(this.jpd.public.answers).sort(
      (a, b) => {
        return this.jpd.public.buzzes[a] - this.jpd.public.buzzes[b];
      },
    );
    this.jpdSnapshot = JSON.parse(JSON.stringify(this.jpd));
    this.advanceJudging(false);
    this.sendState();
  };

  advanceJudging = (skipRemaining: boolean) => {
    if (this.jpd.public.currentJudgeAnswerIndex === undefined) {
      this.jpd.public.currentJudgeAnswerIndex = 0;
    } else {
      this.jpd.public.currentJudgeAnswerIndex += 1;
    }
    this.jpd.public.currentJudgeAnswer =
      this.jpd.public.judgeArr?.[this.jpd.public.currentJudgeAnswerIndex];
    // Either we picked a correct answer (in standard mode) or ran out of players to judge
    if (skipRemaining || this.jpd.public.currentJudgeAnswer === undefined) {
      this.jpd.public.canNextQ = true;
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
  };

  doAiJudge = async (data: { currentQ: string; id: string }) => {
    // count the number of automatic judges
    redisCount("aiJudge");
    // currentQ: The board coordinates of the current question, e.g. 1_3
    // id: clientId of the person being judged
    const { currentQ, id } = data;
    // The question text
    const q = this.jpd.board[currentQ]?.q ?? "";
    const a = this.jpd.public.currentAnswer ?? "";
    const response = this.jpd.public.answers[id];
    let correct: boolean | null = null;
    if (response === "") {
      // empty response is always wrong
      correct = false;
      redisCount("aiShortcut");
    } else if (response.toLowerCase().trim() === a.toLowerCase().trim()) {
      // exact match is always right
      correct = true;
      redisCount("aiShortcut");
    } else {
      // count the number of calls to chatgpt
      redisCount("aiChatGpt");
      try {
        const decision = await getOpenAIDecision(q, a, response);
        console.log("[AIDECISION]", id, q, a, response, decision);
        if (decision && decision.correct != null) {
          correct = decision.correct;
        } else {
          redisCount("aiRefuse");
        }
        // Log the AI decision to measure accuracy
        // If the user undoes and then chooses differently than AI, then that's a failed decision
        // Alternative: we can just highlight what the AI thinks is correct instead of auto-applying the decision, then we'll have user feedback for sure
        // If undefined, AI refused to answer
        redis?.lpush(
          "jpd:aiJudges",
          JSON.stringify({ q, a, response, correct: decision?.correct }),
        );
        redis?.ltrim("jpd:aiJudges", 0, 1000);
      } catch (e) {
        console.log(e);
      }
    }
    if (correct != null) {
      this.judgeAnswer(undefined, { currentQ, id, correct });
    }
  };

  doHumanJudge = (
    judgeId: string,
    raw: unknown,
  ) => {
    if (raw == null || typeof raw !== "object") {
      return;
    }
    const data = raw as { currentQ: string; id: string; correct: boolean | null };
    redisCount("humanJudge");
    const success = this.judgeAnswer(judgeId, data);
  };

  judgeAnswer = (
    judgeId: string | undefined,
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
    // TODO This is disabled for now since we might have some old reconnecting clients
    // if (!isValidUUID(id)) {
    //   // Not valid ID value
    //   return;
    // }
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
    if (this.settings.host && judgeId && judgeId !== this.settings.host) {
      // Not the host
      return false;
    }
    this.jpd.public.judges[id] = correct;
    console.log("[JUDGE]", id, correct);
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
      const judgeName = this.roster.find((p) => p.id === judgeId)?.name;
      const targetName = this.roster.find((p) => p.id === id)?.name;
      const msg = {
        id: judgeId ?? "",
        // name of judge
        name: judgeName ?? "System",
        bot: !Boolean(judgeName),
        cmd: "judge",
        msg: JSON.stringify({
          id: id,
          // name of person being judged
          name: targetName,
          answer: this.jpd.public.answers[id],
          correct,
          delta: correct ? delta : -delta,
          confidence,
        }),
      };
      this.addChatMessage(msg);
      if (!judgeId) {
        this.aiJudged = true;
      }
    }
    const allowMultipleCorrect =
      this.jpd.public.round === "final" || this.settings.allowMultipleCorrect;
    const skipRemaining = !allowMultipleCorrect && correct === true;
    this.advanceJudging(skipRemaining);

    if (this.jpd.public.canNextQ) {
      this.nextQuestion();
    } else {
      this.sendState();
    }
    return correct != null;
  };

  submitWager = (id: string, wager: number) => {
    if (id in this.jpd.wagers) {
      return;
    }
    // User setting a wager for DD or final
    // Can bet up to current score, minimum of 1000 in single or 2000 in double, 0 in final
    let maxWager = 0;
    let minWager = 5;
    if (this.jpd.public.round === "jeopardy") {
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 1000);
    } else if (this.jpd.public.round === "double") {
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 2000);
    } else if (this.jpd.public.round === "triple") {
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 3000);
    } else if (this.jpd.public.round === "final") {
      minWager = 0;
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 0);
    }
    let numWager = Number(wager);
    if (Number.isNaN(numWager)) {
      numWager = minWager;
    } else {
      numWager = Math.min(Math.max(numWager, minWager), maxWager);
    }
    if (id === this.jpd.public.dailyDoublePlayer && this.jpd.public.currentQ) {
      this.jpd.wagers[id] = numWager;
      this.jpd.public.wagers[id] = numWager;
      this.revealQuestion();
    } else if (this.jpd.public.round === "final" && this.jpd.public.currentQ) {
      // store the wagers privately until everyone's made one
      this.jpd.wagers[id] = numWager;
      if (this.jpd.public.waitingForWager) {
        delete this.jpd.public.waitingForWager[id];
      }
      if (Object.keys(this.jpd.public.waitingForWager ?? {}).length === 0) {
        // if final, reveal clue if all players made wager
        this.revealQuestion();
      } else {
        this.sendState();
      }
    }
  };

  setWagerTimeout = (durationMs: number, endTS?: number) => {
    this.jpd.public.wagerEndTS = endTS ?? Date.now() + durationMs;
    this.wagerTimeout = setTimeout(() => {
      if (Object.keys(this.jpd.public.waitingForWager ?? {}).length === 0) {
        // if no active players, need to move on anyway
        this.revealQuestion();
      } else {
        Object.keys(this.jpd.public.waitingForWager ?? {}).forEach((id) => {
          this.submitWager(id, 0);
        });
      }
    }, durationMs);
  };

  revealQuestion = () => {
    this.jpd.public.waitingForWager = undefined;
    if (this.jpd.public.board[this.jpd.public.currentQ]) {
      this.jpd.public.board[this.jpd.public.currentQ].question =
        this.jpd.board[this.jpd.public.currentQ]?.q;
    }
    this.triggerPlayClue();
    this.sendState();
  };

  triggerPlayClue = () => {
    clearTimeout(this.wagerTimeout);
    this.jpd.public.wagerEndTS = 0;
    const clue = this.jpd.public.board[this.jpd.public.currentQ];
    this.io
      .of(this.roomId)
      .emit("JPD:playClue", this.jpd.public.currentQ, clue && clue.question);
    let speakingTime = 0;
    if (clue && clue.question) {
      // Allow some time for reading the text, based on content
      // Count syllables in text, assume speaking rate of 4 syll/sec
      const syllCountArr = clue.question
        // Remove parenthetical starts and blanks
        .replace(/^\(.*\)/, "")
        .replace(/_+/g, " blank ")
        .split(" ")
        .map((word: string) => syllableCount(word));
      const totalSyll = syllCountArr.reduce((a: number, b: number) => a + b, 0);
      // Minimum 1 second speaking time
      speakingTime = Math.max((totalSyll / 4) * 1000, 1000);
      this.jpd.public.playClueEndTS = Date.now() + speakingTime;
    }
    this.setPlayClueTimeout(speakingTime);
  };

  setPlayClueTimeout = (durationMs: number) => {
    this.playClueTimeout = setTimeout(() => {
      this.playClueDone();
    }, durationMs);
  };

  playClueDone = () => {
    clearTimeout(this.playClueTimeout);
    this.jpd.public.playClueEndTS = 0;
    this.jpd.public.buzzUnlockTS = Date.now();
    if (this.jpd.public.round === "final") {
      this.unlockAnswer(this.settings.finalTimeout);
      // Play final jeopardy music
      this.io.of(this.roomId).emit("JPD:playFinalJeopardy");
    } else {
      if (!this.jpd.public.currentDailyDouble) {
        // DD already handles buzzing automatically
        this.jpd.public.canBuzz = true;
      }
      this.unlockAnswer(this.settings.answerTimeout);
    }
    this.sendState();
  };

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
    console.log("%s strings to generate", strings.size);
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
    Array(numWorkers)
      .fill("")
      .forEach(async (_, workerIndex) => {
        for (let [i, text] of cursor) {
          try {
            const url = await genAITextToSpeech(rvcHost, text ?? "");
            // Report progress back in chat messages
            if (url) {
              this.addChatMessage({
                id: "",
                name: "System",
                bot: true,
                msg: "generated ai voice " + i + ": " + url,
              });
              redisCount("aiVoice");
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
          this.addChatMessage({
            id: "",
            name: "System",
            bot: true,
            msg:
              success +
              "/" +
              count +
              " voices generated in " +
              (end - start) +
              "ms",
          });
        }
      });
  };
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
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, ""); //word.sub!(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
  word = word.replace(/^y/, "");
  let vowels = word.match(/[aeiouy]{1,2}/g);
  // Use 3 as the default if no letters, it's probably a year
  return vowels ? vowels.length : 3;
}

function isValidUUID(id: string) {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[4][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(
    id,
  );
}
