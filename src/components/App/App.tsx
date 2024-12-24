import './App.css';
import React from 'react';
import { Divider, Grid, Icon, Input } from 'semantic-ui-react';
import { serverPath, generateName } from '../../utils';
import { Chat } from '../Chat/Chat';
import { JeopardyTopBar } from '../TopBar/TopBar';
import { Jeopardy } from '../Jeopardy/Jeopardy';
import { type Socket } from 'socket.io-client';

export interface AppState {
  participants: User[];
  rosterUpdateTS: Number;
  chat: ChatMessage[];
  myName: string;
  scrollTimestamp: number;
  socket: Socket | undefined;
}

export default class App extends React.Component<null, AppState> {
  state: AppState = {
    participants: [],
    rosterUpdateTS: Date.now(),
    chat: [],
    myName: '',
    scrollTimestamp: 0,
    socket: undefined,
  };

  async componentDidMount() {
    // Send heartbeat to the server
    window.setInterval(
      () => {
        window.fetch(serverPath + '/ping');
      },
      10 * 60 * 1000,
    );
  }

  updateName = (name: string) => {
    if (this.state.socket) {
      this.setState({ myName: name });
      this.state.socket.emit('CMD:name', name);
      window.localStorage.setItem('watchparty-username', name);
    }
  };

  addChatMessage = (data: ChatMessage) => {
    this.state.chat.push(data);
    this.setState({
      chat: this.state.chat,
      scrollTimestamp: Number(new Date()),
    });
  };

  render() {
    return (
      <React.Fragment>
        <JeopardyTopBar />
        {
          <Grid stackable celled="internally">
            <Grid.Row>
              <Grid.Column width={12}>
                <Jeopardy
                  setAppState={(state) => this.setState(state as AppState)}
                  participants={this.state.participants}
                  updateName={this.updateName}
                  addChatMessage={this.addChatMessage}
                />
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
                  onChange={(e, data) => this.updateName(data.value)}
                  icon={
                    <Icon
                      onClick={async () =>
                        this.updateName(await generateName())
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
