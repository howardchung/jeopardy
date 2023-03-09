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
require('dotenv').config();
const fs_1 = __importDefault(require("fs"));
const util_1 = __importDefault(require("util"));
const express_1 = __importDefault(require("express"));
const compression_1 = __importDefault(require("compression"));
const os_1 = __importDefault(require("os"));
const cors_1 = __importDefault(require("cors"));
const ioredis_1 = __importDefault(require("ioredis"));
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const room_1 = require("./room");
const redis_1 = require("./utils/redis");
const moniker_1 = require("./utils/moniker");
const app = (0, express_1.default)();
let server = null;
if (process.env.HTTPS) {
    const key = fs_1.default.readFileSync(process.env.SSL_KEY_FILE);
    const cert = fs_1.default.readFileSync(process.env.SSL_CRT_FILE);
    server = https_1.default.createServer({ key: key, cert: cert }, app);
}
else {
    server = new http_1.default.Server(app);
}
const io = new socket_io_1.Server(server, { cors: { origin: '*' } });
let redis = null;
if (process.env.REDIS_URL) {
    redis = new ioredis_1.default(process.env.REDIS_URL);
}
const rooms = new Map();
const permaRooms = ['/default', '/smokestack', '/howard-and-katie'];
init();
function saveRoomsToRedis() {
    return __awaiter(this, void 0, void 0, function* () {
        while (true) {
            // console.time('roomSave');
            const roomArr = Array.from(rooms.values());
            for (let i = 0; i < roomArr.length; i++) {
                if (roomArr[i].roster.length) {
                    const roomData = roomArr[i].serialize();
                    const key = roomArr[i].roomId;
                    yield (redis === null || redis === void 0 ? void 0 : redis.setex(key, 24 * 60 * 60, roomData));
                    if (permaRooms.includes(key)) {
                        yield (redis === null || redis === void 0 ? void 0 : redis.persist(key));
                    }
                }
            }
            // console.timeEnd('roomSave');
            yield new Promise((resolve) => setTimeout(resolve, 1000));
        }
    });
}
function init() {
    return __awaiter(this, void 0, void 0, function* () {
        if (redis) {
            // Load rooms from Redis
            console.log('loading rooms from redis');
            const keys = yield redis.keys('/*');
            console.log(util_1.default.format('found %s rooms in redis', keys.length));
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const roomData = yield redis.get(key);
                console.log(key, roomData === null || roomData === void 0 ? void 0 : roomData.length);
                rooms.set(key, new room_1.Room(io, key, roomData));
            }
            // Start saving rooms to Redis
            saveRoomsToRedis();
        }
        permaRooms.forEach((room) => {
            if (!rooms.has(room)) {
                rooms.set(room, new room_1.Room(io, room));
            }
        });
        server.listen(process.env.PORT || 8080);
    });
}
app.use((0, cors_1.default)());
app.use((0, compression_1.default)());
app.use(express_1.default.static('build'));
app.get('/ping', (req, res) => {
    res.json('pong');
});
app.get('/stats', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    if (req.query.key && req.query.key === process.env.STATS_KEY) {
        const roomData = [];
        const now = Number(new Date());
        let currentUsers = 0;
        rooms.forEach((room) => {
            const obj = {
                creationTime: room.creationTime,
                roomId: room.roomId,
                rosterLength: room.roster.length,
            };
            currentUsers += obj.rosterLength;
            roomData.push(obj);
        });
        // Sort newest first
        roomData.sort((a, b) => b.creationTime - a.creationTime);
        const cpuUsage = os_1.default.loadavg();
        const redisUsage = (_b = (_a = (yield (redis === null || redis === void 0 ? void 0 : redis.info()))) === null || _a === void 0 ? void 0 : _a.split('\n').find((line) => line.startsWith('used_memory:'))) === null || _b === void 0 ? void 0 : _b.split(':')[1].trim();
        const chatMessages = yield (0, redis_1.getRedisCountDay)('chatMessages');
        const newGames = yield (0, redis_1.getRedisCountDay)('newGames');
        const customGames = yield (0, redis_1.getRedisCountDay)('customGames');
        const nonTrivialJudges = yield (redis === null || redis === void 0 ? void 0 : redis.llen('jpd:nonTrivialJudges'));
        const jeopardyResults = yield (redis === null || redis === void 0 ? void 0 : redis.llen('jpd:results'));
        res.json({
            roomCount: rooms.size,
            cpuUsage,
            redisUsage,
            chatMessages,
            currentUsers,
            newGames,
            customGames,
            nonTrivialJudges,
            jeopardyResults,
            rooms: roomData,
        });
    }
    else {
        return res.status(403).json({ error: 'Access Denied' });
    }
}));
app.get('/jeopardyResults', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.query.key && req.query.key === process.env.STATS_KEY) {
        const data = yield (redis === null || redis === void 0 ? void 0 : redis.lrange('jpd:results', 0, -1));
        return res.json(data);
    }
    else {
        return res.status(403).json({ error: 'Access Denied' });
    }
}));
app.get('/nonTrivialJudges', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.query.key && req.query.key === process.env.STATS_KEY) {
        const data = yield (redis === null || redis === void 0 ? void 0 : redis.lrange('jpd:nonTrivialJudges', 0, -1));
        return res.json(data);
    }
    else {
        return res.status(403).json({ error: 'Access Denied' });
    }
}));
app.post('/createRoom', (req, res) => {
    const genName = () => '/' + (0, moniker_1.makeRoomName)();
    let name = genName();
    // Keep retrying until no collision
    while (rooms.has(name)) {
        name = genName();
    }
    console.log('createRoom: ', name);
    const newRoom = new room_1.Room(io, name);
    rooms.set(name, newRoom);
    res.json({ name: name.slice(1) });
});
app.get('/generateName', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    return res.send((0, moniker_1.makeUserName)());
}));
