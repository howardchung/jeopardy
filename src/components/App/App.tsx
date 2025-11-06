import './App.css';
import React, { useCallback, useEffect, useState } from 'react';
import { ActionIcon, Grid, TextInput } from '@mantine/core';
import { IconArrowsShuffle } from '@tabler/icons-react';
import { serverPath, generateName } from '../../utils';
import { Chat } from '../Chat/Chat';
import { JeopardyTopBar } from '../TopBar/TopBar';
import { Jeopardy } from '../Jeopardy/Jeopardy';
import { type Socket } from 'socket.io-client';

export function App() {
  const [participants, setParticipants] = useState<User[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [myName, setMyName] = useState('');
  const [scrollTimestamp, setScrollTimestamp] = useState(0);
  const [socket, setSocket] = useState<Socket | undefined>(undefined);

  useEffect(() => {
    const heartbeat = window.setInterval(
      () => {
        window.fetch(serverPath + '/ping');
      },
      10 * 60 * 1000,
    );
    return () => {
      window.clearInterval(heartbeat);
    };
  });

  const updateName = useCallback(
    (name: string) => {
      if (socket) {
        setMyName(name);
        socket.emit('CMD:name', name);
        window.localStorage.setItem('watchparty-username', name);
      }
    },
    [socket],
  );

  return (
    <React.Fragment>
      <JeopardyTopBar />
      {
        <Grid style={{ paddingLeft: '10px', paddingRight: '10px' }} gutter={10}>
          <Grid.Col
            style={{ position: 'relative' }}
            span={{ base: 12, md: 9 }}
            className="fullHeightColumn"
          >
            <Jeopardy
              participants={participants}
              chat={chat}
              updateName={updateName}
              setParticipants={setParticipants}
              setSocket={setSocket}
              setScrollTimestamp={setScrollTimestamp}
              setChat={setChat}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 3 }} className="fullHeightColumn">
            <TextInput
              leftSection={<div style={{ whiteSpace: 'nowrap' }}>Name:</div>}
              leftSectionWidth={60}
              value={myName}
              onChange={(e) => updateName(e.target.value)}
              rightSection={
                <ActionIcon
                  radius="md"
                  onClick={async () => updateName(await generateName())}
                >
                  <IconArrowsShuffle size={20} />
                </ActionIcon>
              }
            />
            <Chat
              chat={chat}
              scrollTimestamp={scrollTimestamp}
              socket={socket}
            />
          </Grid.Col>
        </Grid>
      }
    </React.Fragment>
  );
}
