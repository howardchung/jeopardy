import { Jeopardy } from './jeopardy';
import { Socket, Server } from 'socket.io';
import Redis from 'ioredis';
import { redisCount } from './utils/redis';

// let redis = undefined as unknown as Redis;
// if (process.env.REDIS_URL) {
//   redis = new Redis(process.env.REDIS_URL);
// }

export class Room {
  public roster: User[] = [];
  private chat: ChatMessage[] = [];
  public nameMap: StringDict = {};
  private pictureMap: StringDict = {};
  private io: Server;
  public roomId: string;
  public creationTime: Date = new Date();
  private jpd: Jeopardy | null = null;

  constructor(
    io: Server,
    roomId: string,
    roomData?: string | null | undefined,
  ) {
    this.roomId = roomId;
    this.io = io;

    if (roomData) {
      this.deserialize(roomData);
    }

    if (!this.jpd) {
      this.jpd = new Jeopardy(io, roomId, this.roster, this);
    }

    io.of(roomId).on('connection', (socket: Socket) => {
      // console.log(socket.id);
      this.roster.push({ id: socket.id });
      redisCount('connectStarts');

      socket.emit('REC:nameMap', this.nameMap);
      socket.emit('REC:pictureMap', this.pictureMap);
      socket.emit('chatinit', this.chat);
      io.of(roomId).emit('roster', this.roster);

      socket.on('CMD:name', (data: string) => {
        if (!data) {
          return;
        }
        if (data && data.length > 100) {
          return;
        }
        this.nameMap[socket.id] = data;
        io.of(roomId).emit('REC:nameMap', this.nameMap);
      });
      socket.on('CMD:picture', (data: string) => {
        if (data && data.length > 10000) {
          return;
        }
        this.pictureMap[socket.id] = data;
        io.of(roomId).emit('REC:pictureMap', this.pictureMap);
      });
      // socket.on('CMD:chat', (data: string) => {
      //   if (data && data.length > 65536) {
      //     // TODO add some validation on client side too so we don't just drop long messages
      //     return;
      //   }
      //   if (process.env.NODE_ENV === 'development' && data === '/clear') {
      //     this.chat.length = 0;
      //     io.of(roomId).emit('chatinit', this.chat);
      //     return;
      //   }
      //   redisCount('chatMessages');
      //   const chatMsg = { id: socket.id, msg: data };
      //   this.addChatMessage(socket, chatMsg);
      // });

      socket.on('disconnect', () => {
        let index = this.roster.findIndex((user) => user.id === socket.id);
        this.roster.splice(index, 1)[0];
        io.of(roomId).emit('roster', this.roster);
        // delete nameMap[socket.id];
      });
    });
  }

  serialize = () => {
    return JSON.stringify({
      nameMap: this.nameMap,
      pictureMap: this.pictureMap,
      chat: this.chat,
      creationTime: this.creationTime,
      jpd: this.jpd,
    });
  };

  deserialize = (roomData: string) => {
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
      this.jpd = new Jeopardy(
        this.io,
        this.roomId,
        this.roster,
        this,
        roomObj.jpd,
      );
    }
  };

  addChatMessage = (socket: Socket | undefined, chatMsg: any) => {
    const chatWithTime: ChatMessage = {
      ...chatMsg,
      timestamp: new Date().toISOString(),
    };
    this.chat.push(chatWithTime);
    this.chat = this.chat.splice(-100);
    this.io.of(this.roomId).emit('REC:chat', chatWithTime);
  };
}
