import './App.css';
import React from 'react';
import { Divider, Grid, Icon, Input } from 'semantic-ui-react';
//@ts-ignore
import io from 'socket.io-client';
import { serverPath, generateName } from '../../utils';
import { Chat } from '../Chat/Chat';
import { JeopardyTopBar } from '../TopBar/TopBar';
import { Jeopardy } from '../Jeopardy/Jeopardy';

interface AppState {
  state: 'init' | 'starting' | 'connected';
  participants: User[];
  rosterUpdateTS: Number;
  chat: ChatMessage[];
  nameMap: StringDict;
  myName: string;
  myPicture: string;
  scrollTimestamp: number;
  error: string;
}

export default class App extends React.Component<null, AppState> {
  state: AppState = {
    state: 'starting',
    participants: [],
    rosterUpdateTS: Number(new Date()),
    chat: [],
    nameMap: {},
    myName: '',
    myPicture: '',
    scrollTimestamp: 0,
    error: '',
  };
  socket: any = null;

  async componentDidMount() {
    // Send heartbeat to the server
    window.setInterval(
      () => {
        window.fetch(serverPath + '/ping');
      },
      10 * 60 * 1000,
    );

    this.init();
  }

  init = () => {
    // Load room ID from url
    let roomId = '/default';
    let query = window.location.hash.substring(1);
    if (query) {
      roomId = '/' + query;
    }
    this.join(roomId);
  };

  join = async (roomId: string) => {
    const socket = io(serverPath + roomId);
    this.socket = socket;
    socket.on('connect', async () => {
      this.setState({ state: 'connected' });
      // Load username from localstorage
      let userName = window.localStorage.getItem('watchparty-username');
      this.updateName(null, { value: userName || (await generateName()) });
      const savedId = window.localStorage.getItem('jeopardy-savedId');
      if (savedId) {
        socket.emit('JPD:reconnect', savedId);
      }
      // Save our current ID to localstorage
      window.localStorage.setItem('jeopardy-savedId', socket.id);
    });
    socket.on('REC:chat', (data: ChatMessage) => {
      if (document.visibilityState && document.visibilityState !== 'visible') {
        new Audio('/clearly.mp3').play();
      }
      this.state.chat.push(data);
      this.setState({
        chat: this.state.chat,
        scrollTimestamp: Number(new Date()),
      });
    });
    socket.on('REC:nameMap', (data: StringDict) => {
      this.setState({ nameMap: data });
    });
    socket.on('roster', (data: User[]) => {
      this.setState({ participants: data, rosterUpdateTS: Number(new Date()) });
    });
    socket.on('chatinit', (data: any) => {
      this.setState({ chat: data, scrollTimestamp: Number(new Date()) });
    });
  };

  updateName = (e: any, data: { value: string }) => {
    this.setState({ myName: data.value });
    this.socket.emit('CMD:name', data.value);
    window.localStorage.setItem('watchparty-username', data.value);
  };

  updatePicture = (url: string) => {
    this.setState({ myPicture: url });
    this.socket.emit('CMD:picture', url);
  };

  render() {
    return (
      <React.Fragment>
        <JeopardyTopBar />
        {
          <Grid stackable celled="internally">
            <Grid.Row>
              <Grid.Column width={12}>
                {this.state.state === 'connected' && (
                  <Jeopardy
                    socket={this.socket}
                    participants={this.state.participants}
                    nameMap={this.state.nameMap}
                  />
                )}
              </Grid.Column>
              <Grid.Column
                width={4}
                style={{ display: 'flex', flexDirection: 'column' }}
                className="fullHeightColumn"
              >
                <Input
                  inverted
                  fluid
                  label={'My name is:'}
                  value={this.state.myName}
                  onChange={this.updateName}
                  icon={
                    <Icon
                      onClick={async () =>
                        this.updateName(null, { value: await generateName() })
                      }
                      name="random"
                      inverted
                      circular
                      link
                    />
                  }
                />
                <Divider inverted horizontal></Divider>
                <Chat
                  chat={this.state.chat}
                  nameMap={this.state.nameMap}
                  socket={this.socket}
                  scrollTimestamp={this.state.scrollTimestamp}
                  getMediaDisplayName={() => ''}
                />
              </Grid.Column>
            </Grid.Row>
          </Grid>
        }
      </React.Fragment>
    );
  }
}
