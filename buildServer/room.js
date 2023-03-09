"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Room = void 0;
const jeopardy_1 = require("./jeopardy");
const ioredis_1 = __importDefault(require("ioredis"));
const redis_1 = require("./utils/redis");
let redis = undefined;
if (process.env.REDIS_URL) {
    redis = new ioredis_1.default(process.env.REDIS_URL);
}
class Room {
    constructor(io, roomId, roomData) {
        this.roster = [];
        this.chat = [];
        this.nameMap = {};
        this.pictureMap = {};
        this.creationTime = new Date();
        this.jpd = null;
        this.serialize = () => {
            return JSON.stringify({
                nameMap: this.nameMap,
                pictureMap: this.pictureMap,
                chat: this.chat,
                creationTime: this.creationTime,
                jpd: this.jpd,
            });
        };
        this.deserialize = (roomData) => {
            const roomObj = JSON.parse(roomData);
            if (roomObj.chat) {
                this.chat = roomObj.chat;
            }
            if (roomObj.nameMap) {
                this.nameMap = roomObj.nameMap;
            }
            if (roomObj.pictureMap) {
                this.pictureMap = roomObj.pictureMap;
            }
            if (roomObj.creationTime) {
                this.creationTime = new Date(roomObj.creationTime);
            }
            if (roomObj.jpd) {
                this.jpd = new jeopardy_1.Jeopardy(this.io, this.roomId, this.roster, this, roomObj.jpd);
            }
        };
        this.addChatMessage = (socket, chatMsg) => {
            const chatWithTime = Object.assign(Object.assign({}, chatMsg), { timestamp: new Date().toISOString() });
            this.chat.push(chatWithTime);
            this.chat = this.chat.splice(-100);
            this.io.of(this.roomId).emit('REC:chat', chatWithTime);
        };
        this.roomId = roomId;
        this.io = io;
        if (roomData) {
            this.deserialize(roomData);
        }
        if (!this.jpd) {
            this.jpd = new jeopardy_1.Jeopardy(io, roomId, this.roster, this);
        }
        io.of(roomId).on('connection', (socket) => {
            // console.log(socket.id);
            this.roster.push({ id: socket.id });
            (0, redis_1.redisCount)('connectStarts');
            socket.emit('REC:nameMap', this.nameMap);
            socket.emit('REC:pictureMap', this.pictureMap);
            socket.emit('chatinit', this.chat);
            io.of(roomId).emit('roster', this.roster);
            socket.on('CMD:name', (data) => {
                if (!data) {
                    return;
                }
                if (data && data.length > 100) {
                    return;
                }
                this.nameMap[socket.id] = data;
                io.of(roomId).emit('REC:nameMap', this.nameMap);
            });
            socket.on('CMD:picture', (data) => {
                if (data && data.length > 10000) {
                    return;
                }
                this.pictureMap[socket.id] = data;
                io.of(roomId).emit('REC:pictureMap', this.pictureMap);
            });
            socket.on('CMD:chat', (data) => {
                if (data && data.length > 65536) {
                    // TODO add some validation on client side too so we don't just drop long messages
                    return;
                }
                if (process.env.NODE_ENV === 'development' && data === '/clear') {
                    this.chat.length = 0;
                    io.of(roomId).emit('chatinit', this.chat);
                    return;
                }
                (0, redis_1.redisCount)('chatMessages');
                const chatMsg = { id: socket.id, msg: data };
                this.addChatMessage(socket, chatMsg);
            });
            socket.on('disconnect', () => {
                let index = this.roster.findIndex((user) => user.id === socket.id);
                this.roster.splice(index, 1)[0];
                io.of(roomId).emit('roster', this.roster);
                // delete nameMap[socket.id];
            });
        });
    }
}
exports.Room = Room;
