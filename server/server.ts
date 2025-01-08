import fs from 'fs';
import util from 'util';
import express from 'express';
import compression from 'compression';
import os from 'os';
import cors from 'cors';
import https from 'https';
import http from 'http';
import { Server } from 'socket.io';
import { Room } from './room';
import { redis, getRedisCountDay } from './redis';
import { makeRoomName, makeUserName } from './moniker';
import config from './config';
import { getJDataStats } from './jData';

const app = express();
let server = null as https.Server | http.Server | null;
if (config.SSL_KEY_FILE && config.SSL_CRT_FILE) {
  const key = fs.readFileSync(config.SSL_KEY_FILE as string);
  const cert = fs.readFileSync(config.SSL_CRT_FILE as string);
  server = https.createServer({ key: key, cert: cert }, app);
} else {
  server = new http.Server(app);
}
const io = new Server(server, { cors: { origin: '*' }, transports: ['websocket'] });
const rooms = new Map<string, Room>();
init();

async function init() {
  if (redis) {
    // Load rooms from Redis
    console.log('loading rooms from redis');
    const keys = await redis.keys('/*');
    console.log(util.format('found %s rooms in redis', keys.length));
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const roomData = await redis.get(key);
      console.log(key, roomData?.length);
      rooms.set(key, new Room(io, key, roomData));
    }
  }
  config.permaRooms.forEach((roomId) => {
    // Create the room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Room(io, roomId));
    }
  });
  server?.listen(Number(config.PORT));
}

app.use(cors());
app.use(compression());
app.use(express.static('build'));

app.get('/ping', (req, res) => {
  res.json('pong');
});

app.get('/metadata', (req, res) => {
  res.json(getJDataStats());
});

app.get('/stats', async (req, res) => {
  if (req.query.key && req.query.key === config.STATS_KEY) {
    const roomData: any[] = [];
    let currentUsers = 0;
    rooms.forEach((room) => {
      const obj = {
        creationTime: room.creationTime,
        roomId: room.roomId,
        rosterLength: room.getConnectedPlayers().length,
      };
      currentUsers += obj.rosterLength;
      roomData.push(obj);
    });
    // Sort newest first
    roomData.sort((a, b) => b.creationTime - a.creationTime);
    const cpuUsage = os.loadavg();
    const redisUsage = (await redis?.info())
      ?.split('\n')
      .find((line) => line.startsWith('used_memory:'))
      ?.split(':')[1]
      .trim();
    // const chatMessages = await getRedisCountDay('chatMessages');
    const newGamesLastDay = await getRedisCountDay('newGames');
    const customGamesLastDay = await getRedisCountDay('customGames');
    const aiJudgeLastDay = await getRedisCountDay('aiJudge'); 
    const aiShortcutLastDay = await getRedisCountDay('aiShortcut');
    const aiChatGptLastDay = await getRedisCountDay('aiChatGpt');
    const aiRefuseLastDay = await getRedisCountDay('aiRefuse');
    const undoLastDay = await getRedisCountDay('undo');
    const aiUndoLastDay = await getRedisCountDay('aiUndo');
    const aiVoiceLastDay = await getRedisCountDay('aiVoice');
    const savesLastDay = await getRedisCountDay('saves');
    const nonTrivialJudges = await redis?.llen('jpd:nonTrivialJudges');
    const jeopardyResults = await redis?.llen('jpd:results');
    const aiJudges = await redis?.llen('jpd:aiJudges');

    res.json({
      uptime: process.uptime(),
      roomCount: rooms.size,
      cpuUsage,
      redisUsage,
      // chatMessages,
      currentUsers,
      newGamesLastDay,
      customGamesLastDay,
      aiJudgeLastDay,
      aiShortcutLastDay,
      aiChatGptLastDay,
      aiRefuseLastDay,
      undoLastDay,
      aiUndoLastDay,
      aiVoiceLastDay,
      savesLastDay,
      nonTrivialJudges,
      jeopardyResults,
      aiJudges,
      rooms: roomData,
    });
  } else {
    res.status(403).json({ error: 'Access Denied' });
  }
});

app.get('/jeopardyResults', async (req, res) => {
  if (req.query.key && req.query.key === config.STATS_KEY) {
    const data = await redis?.lrange('jpd:results', 0, -1);
    res.json(data);
  } else {
    res.status(403).json({ error: 'Access Denied' });
  }
});

app.get('/nonTrivialJudges', async (req, res) => {
  if (req.query.key && req.query.key === config.STATS_KEY) {
    const data = await redis?.lrange('jpd:nonTrivialJudges', 0, -1);
    res.json(data);
  } else {
    res.status(403).json({ error: 'Access Denied' });
  }
});

app.get('/aiJudges', async (req, res) => {
  if (req.query.key && req.query.key === config.STATS_KEY) {
    const data = await redis?.lrange('jpd:aiJudges', 0, -1);
    res.json(data);
  } else {
    res.status(403).json({ error: 'Access Denied' });
  }
});

app.post('/createRoom', (req, res) => {
  const genName = () => '/' + makeRoomName();
  let name = genName();
  // Keep retrying until no collision
  while (rooms.has(name)) {
    name = genName();
  }
  console.log('createRoom: ', name);
  const newRoom = new Room(io, name);
  rooms.set(name, newRoom);
  res.json({ name: name.slice(1) });
});

app.get('/generateName', (req, res) => {
  res.send(makeUserName());
});
