require('dotenv').config();
import fs from 'fs';
import util from 'util';
import express from 'express';
import compression from 'compression';
import os from 'os';
import cors from 'cors';
import Redis from 'ioredis';
import https from 'https';
import http from 'http';
import { Server } from 'socket.io';
import { Room } from './room';
import { getRedisCountDay } from './utils/redis';
import { makeRoomName, makeUserName } from './utils/moniker';

const app = express();
let server: any = null;
if (process.env.HTTPS) {
  const key = fs.readFileSync(process.env.SSL_KEY_FILE as string);
  const cert = fs.readFileSync(process.env.SSL_CRT_FILE as string);
  server = https.createServer({ key: key, cert: cert }, app);
} else {
  server = new http.Server(app);
}
const io = new Server(server, { cors: { origin: '*' } });
let redis: Redis | null = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
}

const rooms = new Map<string, Room>();
const permaRooms = ['/default', '/smokestack', '/howard-and-katie', '/liz'];
init();

async function saveRoomsToRedis() {
  while (true) {
    // console.time('roomSave');
    const roomArr = Array.from(rooms.values());
    for (let i = 0; i < roomArr.length; i++) {
      if (roomArr[i].roster.length) {
        const roomData = roomArr[i].serialize();
        const key = roomArr[i].roomId;
        await redis?.setex(key, 24 * 60 * 60, roomData);
        if (permaRooms.includes(key)) {
          await redis?.persist(key);
        }
      }
    }
    // console.timeEnd('roomSave');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
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
    // Start saving rooms to Redis
    saveRoomsToRedis();
  }
  permaRooms.forEach((room) => {
    if (!rooms.has(room)) {
      rooms.set(room, new Room(io, room));
    }
  });

  server.listen(process.env.PORT || 8081);
}

app.use(cors());
app.use(compression());
app.use(express.static('build'));

app.get('/ping', (req, res) => {
  res.json('pong');
});

app.get('/stats', async (req, res) => {
  if (req.query.key && req.query.key === process.env.STATS_KEY) {
    const roomData: any[] = [];
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
    const cpuUsage = os.loadavg();
    const redisUsage = (await redis?.info())
      ?.split('\n')
      .find((line) => line.startsWith('used_memory:'))
      ?.split(':')[1]
      .trim();
    const chatMessages = await getRedisCountDay('chatMessages');
    const newGames = await getRedisCountDay('newGames');
    const customGames = await getRedisCountDay('customGames');
    const nonTrivialJudges = await redis?.llen('jpd:nonTrivialJudges');
    const jeopardyResults = await redis?.llen('jpd:results');

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
  } else {
    return res.status(403).json({ error: 'Access Denied' });
  }
});

app.get('/jeopardyResults', async (req, res) => {
  if (req.query.key && req.query.key === process.env.STATS_KEY) {
    const data = await redis?.lrange('jpd:results', 0, -1);
    return res.json(data);
  } else {
    return res.status(403).json({ error: 'Access Denied' });
  }
});

app.get('/nonTrivialJudges', async (req, res) => {
  if (req.query.key && req.query.key === process.env.STATS_KEY) {
    const data = await redis?.lrange('jpd:nonTrivialJudges', 0, -1);
    return res.json(data);
  } else {
    return res.status(403).json({ error: 'Access Denied' });
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

app.get('/generateName', async (req, res) => {
  return res.send(makeUserName());
});
