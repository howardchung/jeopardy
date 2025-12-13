import util from "node:util";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import os from "node:os";
import { Server } from "socket.io";
import { Room } from "./room.ts";
import { redis, getRedisCountDay } from "./redis.ts";
import { makeRoomName, makeUserName } from "./moniker.ts";
import config from "./config.ts";
import { getJDataStats } from "./jData.ts";

const rooms = new Map<string, Room>();
const app = new Hono();
app.use("*", cors());
app.use("*", compress());
app.use(serveStatic({ root: "./build" }));
app.get("/ping", async (c) => {
  return c.json("pong");
});

app.get("/metadata", async (c) => {
  return c.json(getJDataStats());
});

app.get("/stats", async (c) => {
  if (c.req.query("key") && c.req.query("key") === config.STATS_KEY) {
    const roomData: any[] = [];
    let currentUsers = 0;
    rooms.forEach((room) => {
      const obj = {
        creationTime: room.creationTime,
        roomId: room.roomId,
        rosterLength: room.getAllPlayers().filter((p) => p.connected).length,
      };
      currentUsers += obj.rosterLength;
      roomData.push(obj);
    });
    // Sort newest first
    roomData.sort((a, b) => b.creationTime - a.creationTime);
    const cpuUsage = os.loadavg();
    const redisUsage = (await redis?.info())
      ?.split("\n")
      .find((line) => line.startsWith("used_memory:"))
      ?.split(":")[1]
      .trim();
    // const chatMessages = await getRedisCountDay('chatMessages');
    const newGamesLastDay = await getRedisCountDay("newGames");
    const customGamesLastDay = await getRedisCountDay("customGames");
    const aiJudgeLastDay = await getRedisCountDay("aiJudge");
    const aiShortcutLastDay = await getRedisCountDay("aiShortcut");
    const aiChatGptLastDay = await getRedisCountDay("aiChatGpt");
    const aiRefuseLastDay = await getRedisCountDay("aiRefuse");
    const undoLastDay = await getRedisCountDay("undo");
    const aiUndoLastDay = await getRedisCountDay("aiUndo");
    const aiVoiceLastDay = await getRedisCountDay("aiVoice");
    const savesLastDay = await getRedisCountDay("saves");
    const nonTrivialJudges = await redis?.llen("jpd:nonTrivialJudges");
    const jeopardyResults = await redis?.llen("jpd:results");
    const aiJudges = await redis?.llen("jpd:aiJudges");

    return c.json({
      uptime: process.uptime(),
      roomCount: rooms.size,
      cpuUsage,
      redisUsage,
      memUsage: process.memoryUsage().rss,
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
    c.status(403);
    return c.json({ error: "Access Denied" });
  }
});

app.get("/jeopardyResults", async (c) => {
  if (c.req.query("key") && c.req.query("key") === config.STATS_KEY) {
    const data = await redis?.lrange("jpd:results", 0, -1);
    return c.json(data);
  } else {
    c.status(403);
    return c.json({ error: "Access Denied" });
  }
});

app.get("/aiJudges", async (c) => {
  if (c.req.query("key") && c.req.query("key") === config.STATS_KEY) {
    const data = await redis?.lrange("jpd:aiJudges", 0, -1);
    return c.json(data);
  } else {
    c.status(403);
    return c.json({ error: "Access Denied" });
  }
});

app.post("/createRoom", async (c) => {
  const genName = () => "/" + makeRoomName();
  let name = genName();
  // Keep retrying until no collision
  while (rooms.has(name)) {
    name = genName();
  }
  console.log("createRoom: ", name);
  const newRoom = new Room(io, name);
  newRoom.saveRoom();
  rooms.set(name, newRoom);
  return c.json({ name: name.slice(1) });
});

app.get("/generateName", async (c) => {
  return c.text(makeUserName());
});

setInterval(freeUnusedRooms, 5 * 60 * 1000);
async function freeUnusedRooms() {
  // Only run if redis persistence is turned on
  // Clean up rooms that are no longer in redis and empty
  // Frees up some JS memory space when process is long-running
  // If running without redis, keep rooms in memory
  // We don't currently attempt to reload rooms from redis on demand
  if (redis) {
    rooms.forEach(async (room, key) => {
      if (room.roster.length === 0 && !(await redis?.get(key))) {
        clearInterval(room.cleanupInterval);
        rooms.delete(key);
        // Unregister the namespace to avoid dupes
        io._nsps.delete(key);
      }
    });
  }
}

const server = serve({
  fetch: app.fetch,
});
server.close();
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket"],
});

if (redis) {
  // Load rooms from Redis
  console.log("loading rooms from redis");
  const keys = await redis.keys("/*");
  console.log(util.format("found %s rooms in redis", keys.length));
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
server.listen(Number(config.PORT));
