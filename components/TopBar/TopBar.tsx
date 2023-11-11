import React from 'react';
import { serverPath } from '../../utils';
import { Icon, Popup, Button } from 'semantic-ui-react';
import '../Jeopardy/Jeopardy.css';

export class NewRoomButton extends React.Component<{ size?: string }> {
  createRoom = async () => {
    const response = await window.fetch(serverPath + '/createRoom', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    const { name } = data;
    window.location.hash = '#' + name;
    window.location.reload();
  };
  render() {
    return (
      <Popup
        content="Create a new room with a random URL that you can share with friends"
        trigger={
          <Button
            color="blue"
            size={this.props.size as any}
            icon
            labelPosition="left"
            onClick={this.createRoom}
            className="toolButton"
          >
            <Icon name="certificate" />
            New Room
          </Button>
        }
      />
    );
  }
}

export class JeopardyTopBar extends React.Component<{ hideNewRoom?: boolean }> {
  createRoom = async () => {
    const response = await window.fetch(serverPath + '/createRoom', {
      method: 'POST',
    });
    const data = await response.json();
    const { name } = data;
    window.location.hash = '#' + name;
    window.location.reload();
  };

  render() {
    return (
      <React.Fragment>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            padding: '1em',
            paddingBottom: '0px',
          }}
        >
          <a href="/" style={{ display: 'flex' }}>
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
              <div className="logo">Jeopardy!</div>
            </div>
          </a>
          <div
            style={{
              display: 'flex',
              marginLeft: '10px',
              alignItems: 'center',
            }}
          >
            <a
              href="https://github.com/howardchung/jeopardy"
              target="_blank"
              rel="noopener noreferrer"
              className="footerIcon"
              title="GitHub"
            >
              <Icon name="github" size="big" link />
            </a>
          </div>
          <div
            style={{
              display: 'flex',
              width: '200px',
              marginLeft: 'auto',
            }}
          >
            {!this.props.hideNewRoom && (
              <Popup
                content="Create a new room with a random URL that you can share with friends"
                trigger={
                  <Button
                    fluid
                    color="blue"
                    size="medium"
                    icon
                    labelPosition="left"
                    onClick={this.createRoom}
                    className="toolButton"
                  >
                    <Icon name="certificate" />
                    New Room
                  </Button>
                }
              />
            )}
          </div>
        </div>
      </React.Fragment>
    );
  }
}
