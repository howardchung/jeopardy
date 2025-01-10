import React, { useEffect, useRef, useState } from 'react';
import { Button, Comment, Icon, Input, Segment } from 'semantic-ui-react';

import { getColorHex, getDefaultPicture } from '../../utils';

interface ChatProps {
  chat: ChatMessage[];
  scrollTimestamp: number;
  className?: string;
  hide?: boolean;
  sendChatMessage: (msg: string) => void;
}

export function Chat (props: ChatProps) {
  const [chatMsg, setChatMsg] = useState('');
  const [isNearBottom, setIsNearBottom] = useState(true);
  const messagesRef = useRef<HTMLDivElement>(null);
  
  const updateChatMsg = (e: any, data: { value: string }) => {
    setChatMsg(data.value);
  };

  const sendChatMsg = () => {
    if (!chatMsg) {
      return;
    }
    setChatMsg('');
    props.sendChatMessage(chatMsg);
  };

  const isChatNearBottom = () => {
    return Boolean(
      messagesRef.current &&
      messagesRef.current.scrollHeight -
        messagesRef.current.scrollTop -
        messagesRef.current.offsetHeight <
        100
    );
  };

  const onScroll = () => {
    setIsNearBottom(isChatNearBottom());
  };

  const scrollToBottom = () => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop =
        messagesRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    scrollToBottom();
    messagesRef.current?.addEventListener('scroll', onScroll);
    return () => {
      messagesRef.current?.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    // if scrolltimestamp updated, we received a new message
    // We don't really need to diff it with the previous props
    // If 0, we haven't scrolled yet and want to always go to bottom
    if (isChatNearBottom() || props.scrollTimestamp === 0) {
      scrollToBottom();
    }
  }, [props.scrollTimestamp, props.chat]);
  return (
    <Segment
      className={props.className}
      inverted
      style={{
        display: props.hide ? 'none' : 'flex',
        flexDirection: 'column',
        flexGrow: '1',
        minHeight: 0,
        marginTop: 0,
        marginBottom: 0,
      }}
    >
      <div
        className="chatContainer"
        ref={messagesRef}
        style={{ position: 'relative' }}
      >
        <Comment.Group>
          {props.chat.map((msg) => (
            <ChatMessage
              key={msg.timestamp + msg.id}
              {...msg}
            />
          ))}
          {/* <div ref={this.messagesEndRef} /> */}
        </Comment.Group>
        {!isNearBottom && (
          <Button
            size="tiny"
            onClick={scrollToBottom}
            style={{
              position: 'sticky',
              bottom: 0,
              display: 'block',
              margin: '0 auto',
            }}
          >
            Jump to bottom
          </Button>
        )}
      </div>
      <Input
        inverted
        fluid
        onKeyPress={(e: any) => e.key === 'Enter' && sendChatMsg()}
        onChange={updateChatMsg}
        value={chatMsg}
        icon={
          <Icon
            onClick={sendChatMsg}
            name="send"
            inverted
            circular
            link
          />
        }
        placeholder="Enter a message..."
      />
    </Segment>
  );
}

const ChatMessage = ({ id, name, timestamp, cmd, msg }: {id: string, name?: string, timestamp: string, cmd: string, msg: string}) => {
  return (
    <Comment>
      <Comment.Avatar src={getDefaultPicture(name ?? '', getColorHex(id))} />
      <Comment.Content>
        <Comment.Author as="a" className="light">
          {name || id}
        </Comment.Author>
        <Comment.Metadata className="dark">
          <div title={new Date(timestamp).toDateString()}>
            {new Date(timestamp).toLocaleTimeString()}
          </div>
        </Comment.Metadata>
        <Comment.Text className="light system">
          {cmd && formatMessage(cmd, msg)}
        </Comment.Text>
        <Comment.Text className="light">{!cmd && msg}</Comment.Text>
      </Comment.Content>
    </Comment>
  );
};

const formatMessage = (cmd: string, msg: string): React.ReactNode | string => {
  if (cmd === 'judge') {
    const { id, correct, answer, delta, name, confidence } = JSON.parse(msg);
    return (
      <span
        style={{ color: correct ? '#21ba45' : '#db2828' }}
      >{`ruled ${name} ${correct ? 'correct' : 'incorrect'}: ${answer} (${
        delta >= 0 ? '+' : ''
      }${delta}) ${
        confidence != null ? `(${(confidence * 100).toFixed(0)}% conf.)` : ''
      }`}</span>
    );
  } else if (cmd === 'answer') {
    return `Correct answer: ${msg}`;
  }
  return cmd;
};