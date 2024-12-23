import { Jeopardy } from './jeopardy';
import { Socket, Server } from 'socket.io';

export class Room {
  public roster: User[] = [];
  public clientIds: Record<string, string> = {};
  private chat: ChatMessage[] = [];
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
      this.jpd = new Jeopardy(io, this);
    }

    io.of(roomId).on('connection', (socket: Socket) => {
      socket.emit('chatinit', this.chat);
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
    });
  }

  serialize = () => {
    return JSON.stringify({
      chat: this.chat,
      clientIds: this.clientIds,
      roster: this.roster,
      creationTime: this.creationTime,
      jpd: this.jpd,
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
    if (roomObj.rostser) {
      this.roster = roomObj.roster;
    }
    if (roomObj.jpd) {
      this.jpd = new Jeopardy(this.io, this, roomObj.jpd);
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

  getConnectedRoster = () => {
    return this.roster.filter((p) => p.connected);
  };
}
