import React, { useCallback } from 'react';
import { serverPath } from '../../utils';
import { Button, ActionIcon } from '@mantine/core';
import '../Jeopardy/Jeopardy.css';
import { IconBrandGithub, IconCirclePlusFilled } from '@tabler/icons-react';
import './TopBar.css';

export function NewRoomButton({size}: { size?: string }) {
  const createRoom = useCallback(async () => {
    const response = await window.fetch(serverPath + '/createRoom', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    const { name } = data;
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.set('game', name);
    window.location.search = searchParams.toString();
  }, []);
  return (
        <Button
          color="blue"
          size={size}
          onClick={createRoom}
          leftSection={<IconCirclePlusFilled />}
        >
          New Room
        </Button>
  );
}

export function JeopardyTopBar({ hideNewRoom }: { hideNewRoom?: boolean }) {
  return (
    <React.Fragment>
      <div
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          padding: '1em',
          paddingBottom: '0px',
        }}
      >
        <a href="/" style={{ display: 'flex', textDecoration: 'none' }}>
          <div
            className="logo small"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '48px',
              width: '48px',
              marginRight: '10px',
              borderRadius: '50%',
              position: 'relative',
              backgroundColor: '#209CEE',
            }}
          >
            J!
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <div className="logo hideMobile">Jeopardy!</div>
          </div>
        </a>
        <div
          style={{
            display: 'flex',
            gap: '0.5em',
            marginLeft: 'auto',
          }}
        >
          {!hideNewRoom && <NewRoomButton />}
          <div
          style={{
            display: 'flex',
          }}
        >
          <a
            href="https://github.com/howardchung/jeopardy"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
          >
            <ActionIcon color="gray" size={36} radius="sm" variant="filled">
              <IconBrandGithub  />
            </ActionIcon>
          </a>
        </div>
        </div>
      </div>
    </React.Fragment>
  );
}
