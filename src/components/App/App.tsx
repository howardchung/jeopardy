import './App.css';
import React, { useCallback, useEffect, useState } from 'react';
import { Divider, Grid, Icon, Input } from 'semantic-ui-react';
import { serverPath, generateName } from '../../utils';
import { Chat } from '../Chat/Chat';
import { JeopardyTopBar } from '../TopBar/TopBar';
import { Jeopardy } from '../Jeopardy/Jeopardy';
import { type Socket } from 'socket.io-client';

export default function App() {
  const [participants, setParticipants] = useState<User[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [myName, setMyName] = useState('');
  const [scrollTimestamp, setScrollTimestamp] = useState(0);
  const [socket, setSocket] = useState<Socket | undefined>(undefined);

  useEffect(() => {
    const heartbeat =  window.setInterval(
      () => {
        window.fetch(serverPath + '/ping');
      },
      10 * 60 * 1000,
    );
    return () => {
      window.clearInterval(heartbeat);
    }
  });

  const updateName = useCallback((name: string) => {
    if (socket) {
      setMyName(name);
      socket.emit('CMD:name', name);
      window.localStorage.setItem('watchparty-username', name);
    }
  }, [socket]);

  return (
    <React.Fragment>
      <JeopardyTopBar />
      {
        <Grid stackable celled="internally">
          <Grid.Row>
            <Grid.Column width={12}>
              <Jeopardy
                participants={participants}
                chat={chat}
                updateName={updateName}
                setParticipants={setParticipants}
                setSocket={setSocket}
                setScrollTimestamp={setScrollTimestamp}
                setChat={setChat}
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
                value={myName}
                onChange={(e, data) => updateName(data.value)}
                icon={
                  <Icon
                    onClick={async () =>
                      updateName(await generateName())
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
                chat={chat}
                scrollTimestamp={scrollTimestamp}
                socket={socket}
              />
            </Grid.Column>
          </Grid.Row>
        </Grid>
      }
    </React.Fragment>
  );
}
