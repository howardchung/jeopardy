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
          const rvcServer = data.split(' ')[1] ?? 'https://azure.howardchung.net/rvc';
          this.jpd?.pregenAIVoices(rvcServer);
        }
        const sender = this.roster.find(p => p.id === socket.id);
        const chatMsg = { id: socket.id, name: sender?.name, msg: data };
        this.addChatMessage(socket, chatMsg);
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
      settings: this.jpd?.settings,
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
      this.roster = roomObj.roster;
    }
    if (roomObj.jpd) {
      this.jpd = new Jeopardy(this.io, this, roomObj.jpd);
    }
    if (roomObj.settings && this.jpd) {
      this.jpd.settings = roomObj.settings;
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
