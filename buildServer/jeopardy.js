"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Jeopardy = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
//@ts-ignore
const papaparse_1 = __importDefault(require("papaparse"));
const redis_1 = require("./utils/redis");
const jData = require('../jeopardy.json');
let redis = undefined;
if (process.env.REDIS_URL) {
    redis = new ioredis_1.default(process.env.REDIS_URL);
}
function constructBoard(questions) {
    // Map of x_y coordinates to questions
    let output = {};
    questions.forEach((q) => {
        output[`${q.x}_${q.y}`] = q;
    });
    return output;
}
function constructPublicBoard(questions) {
    // Map of x_y coordinates to questions
    let output = {};
    questions.forEach((q) => {
        output[`${q.x}_${q.y}`] = {
            value: q.val,
            category: q.cat,
        };
    });
    return output;
}
function syllableCount(word) {
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
        currentAnswer: undefined,
        currentValue: 0,
        currentJudgeAnswer: undefined,
        currentJudgeAnswerIndex: undefined,
        currentDailyDouble: false,
        waitingForWager: undefined,
        playClueDuration: 0,
        playClueEndTS: 0,
        questionDuration: 0,
        questionEndTS: 0,
        wagerEndTS: 0,
        wagerDuration: 0,
        buzzUnlockTS: 0,
        answers: {},
        submitted: {},
        buzzes: {},
        readings: {},
        skips: {},
        judges: {},
        wagers: {},
        canBuzz: false,
        canNextQ: false,
        dailyDoublePlayer: undefined,
    };
}
function getGameState(epNum, airDate, info, jeopardy, double, final) {
    return {
        jeopardy,
        double,
        final,
        answers: {},
        wagers: {},
        board: {},
        public: Object.assign({ epNum,
            airDate,
            info, scoring: 'standard', numCorrect: 0, numTotal: 0, board: {}, scores: {}, round: '', picker: undefined }, getPerQuestionState()),
    };
}
class Jeopardy {
    constructor(io, roomId, roster, room, gameData) {
        this.playClueTimeout = undefined;
        this.questionAnswerTimeout = undefined;
        this.wagerTimeout = undefined;
        this.io = io;
        this.roomId = roomId;
        this.roster = roster;
        this.room = room;
        if (gameData) {
            this.jpd = gameData;
            // Reconstruct the timeouts from the saved state
            if (this.jpd.public.questionEndTS) {
                const remaining = this.jpd.public.questionEndTS - Number(new Date());
                console.log('[QUESTIONENDTS]', remaining);
                this.setQuestionAnswerTimeout(remaining);
            }
            if (this.jpd.public.playClueEndTS) {
                const remaining = this.jpd.public.playClueEndTS - Number(new Date());
                console.log('[PLAYCLUEENDTS]', remaining);
                this.setPlayClueTimeout(remaining);
            }
            if (this.jpd.public.wagerEndTS) {
                const remaining = this.jpd.public.wagerEndTS - Number(new Date());
                console.log('[WAGERENDTS]', remaining);
                this.setWagerTimeout(remaining, this.jpd.public.wagerEndTS);
            }
        }
        else {
            this.jpd = getGameState(undefined, undefined, undefined, [], [], []);
        }
        this.io.of(this.roomId).on('connection', (socket) => {
            this.jpd.public.scores[socket.id] = 0;
            this.emitState();
            // socket.on('JPD:cmdIntro', () => {
            //   this.io.of(this.roomId).emit('JPD:playIntro');
            // });
            socket.on('JPD:init', () => {
                if (this.jpd) {
                    socket.emit('JPD:state', this.jpd.public);
                }
            });
            socket.on('JPD:reconnect', (id) => {
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
                this.emitState();
            });
            socket.on('JPD:start', (episode, filter, data) => {
                if (data && data.length > 1000000) {
                    return;
                }
                this.loadEpisode(episode, filter, data);
            });
            socket.on('JPD:pickQ', (id) => {
                if (this.jpd.public.picker &&
                    this.roster.find((p) => p.id === this.jpd.public.picker) &&
                    this.jpd.public.picker !== socket.id) {
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
                if (this.jpd.board[id].dd && this.jpd.public.scoring !== 'coryat') {
                    // if it is, don't show it yet, we need to collect wager info based only on category
                    this.jpd.public.currentDailyDouble = true;
                    this.jpd.public.dailyDoublePlayer = socket.id;
                    this.jpd.public.waitingForWager = { [socket.id]: true };
                    this.setWagerTimeout(15000);
                    // Autobuzz the player, all others pass
                    this.roster.forEach((p) => {
                        if (p.id === socket.id) {
                            this.jpd.public.buzzes[p.id] = Number(new Date());
                        }
                        else {
                            this.jpd.public.submitted[p.id] = true;
                        }
                    });
                    this.io.of(this.roomId).emit('JPD:playDailyDouble');
                }
                else {
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
                this.jpd.public.buzzes[socket.id] = Number(new Date());
                this.emitState();
            });
            socket.on('JPD:answer', (question, answer) => {
                if (question !== this.jpd.public.currentQ) {
                    return;
                }
                if (!this.jpd.public.questionDuration) {
                    return;
                }
                if (answer && answer.length > 1024) {
                    return;
                }
                console.log('[ANSWER]', socket.id, question, answer);
                if (answer) {
                    this.jpd.answers[socket.id] = answer;
                }
                this.jpd.public.submitted[socket.id] = true;
                this.emitState();
                if (this.jpd.public.round !== 'final' &&
                    this.roster.every((p) => p.id in this.jpd.public.submitted)) {
                    this.revealAnswer();
                }
            });
            socket.on('JPD:wager', (wager) => this.submitWager(socket.id, wager));
            socket.on('JPD:judge', (data) => __awaiter(this, void 0, void 0, function* () {
                const correct = this.jpd.public.currentAnswer;
                const submitted = this.jpd.public.answers[data.id];
                const success = this.judgeAnswer(data, socket);
                if (success) {
                    if (data.correct && redis) {
                        // If the answer was judged correct and non-trivial (equal lowercase), log it for analysis
                        if ((correct === null || correct === void 0 ? void 0 : correct.toLowerCase()) !== (submitted === null || submitted === void 0 ? void 0 : submitted.toLowerCase())) {
                            yield redis.lpush('jpd:nonTrivialJudges', `${correct},${submitted},${1}`);
                            yield redis.ltrim('jpd:nonTrivialJudges', 0, 100000);
                        }
                    }
                }
            }));
            socket.on('JPD:skipQ', () => {
                this.jpd.public.skips[socket.id] = true;
                if (this.jpd.public.canNextQ ||
                    this.roster.every((p) => p.id in this.jpd.public.skips)) {
                    // If everyone votes to skip move to the next question
                    // Or we are in the post-judging phase and can move on
                    this.nextQuestion();
                }
                else {
                    this.emitState();
                }
            });
            socket.on('JPD:scoring', (scoreMethod) => {
                this.jpd.public.scoring = scoreMethod;
                this.emitState();
            });
            socket.on('disconnect', () => {
                if (this.jpd && this.jpd.public) {
                    // If player being judged leaves, skip their answer
                    if (this.jpd.public.currentJudgeAnswer === socket.id) {
                        // This is to run the rest of the code around judging
                        this.judgeAnswer({ id: socket.id, correct: null }, undefined);
                    }
                    // If player who needs to submit wager leaves, submit 0
                    if (this.jpd.public.waitingForWager &&
                        this.jpd.public.waitingForWager[socket.id]) {
                        this.submitWager(socket.id, 0);
                    }
                }
            });
        });
    }
    loadEpisode(number, filter, custom) {
        console.log('[LOADEPISODE]', number, filter, Boolean(custom));
        let loadedData = null;
        if (custom) {
            try {
                const parse = papaparse_1.default.parse(custom, { header: true });
                const typed = parse.data.map((d) => (Object.assign(Object.assign({}, d), { val: Number(d.val), dd: d.dd === 'true', x: Number(d.x), y: Number(d.y) })));
                loadedData = {
                    airDate: new Date().toISOString().split('T')[0],
                    epNum: 'Custom',
                    jeopardy: typed.filter((d) => d.round === 'jeopardy'),
                    double: typed.filter((d) => d.round === 'double'),
                    final: typed.filter((d) => d.round === 'final'),
                };
                console.log(loadedData);
                (0, redis_1.redisCount)('customGames');
            }
            catch (e) {
                console.warn(e);
            }
        }
        else {
            // Load question data into game
            let nums = Object.keys(jData);
            if (filter) {
                // Only load episodes with info matching the filter: kids, teen, college etc.
                nums = nums.filter((num) => jData[num].info && jData[num].info === filter);
            }
            if (number === 'ddtest') {
                loadedData = jData['8000'];
                loadedData['jeopardy'] = loadedData['jeopardy'].filter((q) => q.dd);
            }
            else if (number === 'finaltest') {
                loadedData = jData['8000'];
            }
            else {
                if (!number) {
                    // Random an episode
                    number = nums[Math.floor(Math.random() * nums.length)];
                }
                loadedData = jData[number];
            }
        }
        if (loadedData) {
            (0, redis_1.redisCount)('newGames');
            const { epNum, airDate, info, jeopardy, double, final } = loadedData;
            this.jpd = getGameState(epNum, airDate, info, jeopardy, double, final);
            if (number === 'finaltest') {
                this.jpd.public.round = 'double';
            }
            this.nextRound();
        }
    }
    emitState() {
        this.io.of(this.roomId).emit('JPD:state', this.jpd.public);
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
        this.jpd.public = Object.assign(Object.assign({}, this.jpd.public), getPerQuestionState());
    }
    nextQuestion() {
        this.room.addChatMessage(undefined, {
            id: '',
            cmd: 'answer',
            msg: this.jpd.public.currentAnswer,
        });
        delete this.jpd.public.board[this.jpd.public.currentQ];
        this.resetAfterQuestion();
        if (Object.keys(this.jpd.public.board).length === 0) {
            this.nextRound();
        }
        else {
            this.emitState();
            this.io.of(this.roomId).emit('JPD:playMakeSelection');
        }
    }
    nextRound() {
        var _a;
        this.resetAfterQuestion();
        // advance round counter
        if (this.jpd.public.round === 'jeopardy') {
            this.jpd.public.round = 'double';
            // If double, person with lowest score is picker
            // This is nlogn rather than n, but prob ok for small numbers of players
            if (this.jpd.public.scoring !== 'coryat') {
                const playersWithScores = this.roster.map((p) => ({
                    id: p.id,
                    score: this.jpd.public.scores[p.id] || 0,
                }));
                playersWithScores.sort((a, b) => a.score - b.score);
                this.jpd.public.picker = (_a = playersWithScores[0]) === null || _a === void 0 ? void 0 : _a.id;
            }
        }
        else if (this.jpd.public.round === 'double') {
            this.jpd.public.round = 'final';
            const now = Number(new Date());
            this.jpd.public.waitingForWager = {};
            this.roster.forEach((p) => {
                this.jpd.public.waitingForWager[p.id] = true;
            });
            this.setWagerTimeout(30000);
            // autopick the question
            this.jpd.public.currentQ = '1_1';
            // autobuzz the players in ascending score order
            let playerIds = this.roster.map((p) => p.id);
            playerIds.sort((a, b) => Number(this.jpd.public.scores[a] || 0) -
                Number(this.jpd.public.scores[b] || 0));
            playerIds.forEach((pid) => {
                this.jpd.public.buzzes[pid] = now;
            });
            // Play the category sound
            this.io.of(this.roomId).emit('JPD:playRightanswer');
        }
        else if (this.jpd.public.round === 'final') {
            this.jpd.public.round = 'end';
            // Log the results
            const scores = Object.entries(this.jpd.public.scores);
            scores.sort((a, b) => b[1] - a[1]);
            const scoresNames = scores.map((score) => [
                this.room.nameMap[score[0]],
                score[1],
            ]);
            redis === null || redis === void 0 ? void 0 : redis.lpush('jpd:results', JSON.stringify(scoresNames));
        }
        else {
            this.jpd.public.round = 'jeopardy';
        }
        if (this.jpd.public.round === 'jeopardy' ||
            this.jpd.public.round === 'double' ||
            this.jpd.public.round === 'final') {
            this.jpd.board = constructBoard(this.jpd[this.jpd.public.round]);
            this.jpd.public.board = constructPublicBoard(this.jpd[this.jpd.public.round]);
        }
        this.emitState();
        if (this.jpd.public.round === 'jeopardy' ||
            this.jpd.public.round === 'double') {
            console.log('[PLAYCATEGORIES]', this.jpd.public.round);
            this.playCategories();
        }
    }
    unlockAnswer(duration = 15000) {
        const durationMs = Number(duration);
        this.jpd.public.questionDuration = durationMs;
        this.jpd.public.questionEndTS = Number(new Date()) + durationMs;
        this.setQuestionAnswerTimeout(duration);
    }
    setQuestionAnswerTimeout(durationMs) {
        this.questionAnswerTimeout = setTimeout(() => {
            if (this.jpd.public.round !== 'final') {
                this.io.of(this.roomId).emit('JPD:playTimesUp');
            }
            this.revealAnswer();
        }, durationMs);
    }
    revealAnswer() {
        var _a;
        this.jpd.public.numTotal += 1;
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
        if (this.jpd.public.round !== 'final') {
            // In final, reveal one by one during judging
            this.jpd.public.answers = Object.assign({}, this.jpd.answers);
        }
        this.jpd.public.currentAnswer = (_a = this.jpd.board[this.jpd.public.currentQ]) === null || _a === void 0 ? void 0 : _a.a;
        this.advanceJudging();
        if (!this.jpd.public.currentJudgeAnswer) {
            this.jpd.public.canNextQ = true;
        }
        this.emitState();
    }
    advanceJudging() {
        console.log('[ADVANCEJUDGING]', this.jpd.public.currentJudgeAnswerIndex);
        if (this.jpd.public.currentJudgeAnswerIndex === undefined) {
            this.jpd.public.currentJudgeAnswerIndex = 0;
        }
        else {
            this.jpd.public.currentJudgeAnswerIndex += 1;
        }
        this.jpd.public.currentJudgeAnswer = Object.keys(this.jpd.public.buzzes)[this.jpd.public.currentJudgeAnswerIndex];
        this.jpd.public.wagers[this.jpd.public.currentJudgeAnswer] =
            this.jpd.wagers[this.jpd.public.currentJudgeAnswer];
        this.jpd.public.answers[this.jpd.public.currentJudgeAnswer] =
            this.jpd.answers[this.jpd.public.currentJudgeAnswer];
        // If the current judge player isn't connected, advance again
        if (this.jpd.public.currentJudgeAnswer &&
            !this.roster.find((p) => p.id === this.jpd.public.currentJudgeAnswer)) {
            console.log('[ADVANCEJUDGING] player not found, moving on:', this.jpd.public.currentJudgeAnswer);
            this.advanceJudging();
        }
    }
    judgeAnswer({ id, correct }, socket) {
        if (id in this.jpd.public.judges) {
            // Already judged this player
            return false;
        }
        if (!this.jpd.public.currentQ) {
            // No question picked currently
            return false;
        }
        this.jpd.public.judges[id] = correct;
        console.log('[JUDGE]', id, correct);
        // Currently anyone can pick the correct answer
        // Can turn this into a vote or make a non-player the host
        // MAYBE attempt auto-judging using fuzzy string match
        if (!this.jpd.public.scores[id]) {
            this.jpd.public.scores[id] = 0;
        }
        if (correct === true) {
            this.jpd.public.numCorrect += 1;
            this.jpd.public.scores[id] +=
                this.jpd.public.wagers[id] || this.jpd.public.currentValue;
            if (this.jpd.public.scoring !== 'coryat') {
                // Correct answer is next picker
                this.jpd.public.picker = id;
            }
        }
        if (correct === false) {
            this.jpd.public.scores[id] -=
                this.jpd.public.wagers[id] || this.jpd.public.currentValue;
        }
        // If null, don't change scores
        if (socket) {
            const msg = {
                id: socket.id,
                cmd: 'judge',
                msg: JSON.stringify({
                    id: id,
                    answer: this.jpd.public.answers[id],
                    correct: correct,
                }),
            };
            this.room.addChatMessage(socket, msg);
        }
        this.advanceJudging();
        if (this.jpd.public.round === 'final' ||
            this.jpd.public.scoring === 'coryat') {
            // We can have multiple correct answers in final/Coryat scoring, so only move on if everyone is done
            if (!this.jpd.public.currentJudgeAnswer) {
                this.jpd.public.canNextQ = true;
                this.nextQuestion();
            }
            else {
                this.emitState();
            }
        }
        else {
            if (correct || !this.jpd.public.currentJudgeAnswer) {
                this.jpd.public.canNextQ = true;
                this.nextQuestion();
            }
            else {
                this.emitState();
            }
        }
        return correct !== null;
    }
    submitWager(id, wager) {
        var _a, _b, _c;
        if (id in this.jpd.wagers) {
            return;
        }
        // User setting a wager for DD or final
        // Can bet up to current score, minimum of 1000 in single or 2000 in double, 0 in final
        let maxWager = 0;
        let minWager = 5;
        if (this.jpd.public.round === 'jeopardy') {
            maxWager = Math.max(this.jpd.public.scores[id] || 0, 1000);
        }
        else if (this.jpd.public.round === 'double') {
            maxWager = Math.max(this.jpd.public.scores[id] || 0, 2000);
        }
        else if (this.jpd.public.round === 'final') {
            minWager = 0;
            maxWager = Math.max(this.jpd.public.scores[id] || 0, 0);
        }
        let numWager = Number(wager);
        if (Number.isNaN(Number(wager))) {
            numWager = minWager;
        }
        else {
            numWager = Math.min(Math.max(numWager, minWager), maxWager);
        }
        console.log('[WAGER]', id, wager, numWager);
        if (id === this.jpd.public.dailyDoublePlayer && this.jpd.public.currentQ) {
            this.jpd.wagers[id] = numWager;
            this.jpd.public.wagers[id] = numWager;
            this.jpd.public.waitingForWager = undefined;
            if (this.jpd.public.board[this.jpd.public.currentQ]) {
                this.jpd.public.board[this.jpd.public.currentQ].question =
                    (_a = this.jpd.board[this.jpd.public.currentQ]) === null || _a === void 0 ? void 0 : _a.q;
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
            if (Object.keys((_b = this.jpd.public.waitingForWager) !== null && _b !== void 0 ? _b : {}).length === 0) {
                // if final, reveal clue if all players made wager
                this.jpd.public.waitingForWager = undefined;
                if (this.jpd.public.board[this.jpd.public.currentQ]) {
                    this.jpd.public.board[this.jpd.public.currentQ].question =
                        (_c = this.jpd.board[this.jpd.public.currentQ]) === null || _c === void 0 ? void 0 : _c.q;
                }
                this.triggerPlayClue();
            }
            this.emitState();
        }
    }
    setWagerTimeout(duration, endTS) {
        this.jpd.public.wagerEndTS = endTS !== null && endTS !== void 0 ? endTS : Number(new Date()) + duration;
        this.jpd.public.wagerDuration = duration;
        this.wagerTimeout = setTimeout(() => {
            var _a;
            Object.keys((_a = this.jpd.public.waitingForWager) !== null && _a !== void 0 ? _a : {}).forEach((id) => {
                this.submitWager(id, 0);
            });
        }, duration);
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
                .map((word) => syllableCount(word));
            const totalSyll = syllCountArr.reduce((a, b) => a + b, 0);
            // Minimum 1 second speaking time
            speakingTime = Math.max((totalSyll / 4) * 1000, 1000);
            console.log('[TRIGGERPLAYCLUE]', clue.question, totalSyll, speakingTime);
            this.jpd.public.playClueDuration = speakingTime;
            this.jpd.public.playClueEndTS = Number(new Date()) + speakingTime;
        }
        this.setPlayClueTimeout(speakingTime);
    }
    setPlayClueTimeout(duration) {
        this.playClueTimeout = setTimeout(() => {
            this.playClueDone();
        }, duration);
    }
    playClueDone() {
        console.log('[PLAYCLUEDONE]');
        clearTimeout(this.playClueTimeout);
        this.jpd.public.playClueDuration = 0;
        this.jpd.public.playClueEndTS = 0;
        this.jpd.public.buzzUnlockTS = Number(new Date());
        if (this.jpd.public.currentDailyDouble) {
            this.unlockAnswer();
        }
        else if (this.jpd.public.round === 'final') {
            this.unlockAnswer(30000);
            // Play final jeopardy music
            this.io.of(this.roomId).emit('JPD:playFinalJeopardy');
        }
        else {
            this.jpd.public.canBuzz = true;
            this.unlockAnswer();
        }
        this.emitState();
    }
    toJSON() {
        return this.jpd;
    }
}
exports.Jeopardy = Jeopardy;
