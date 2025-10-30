import React, { useEffect, useRef, useState } from 'react';
import { ActionIcon, Avatar, Button, Group, TextInput } from '@mantine/core';
import { getColorHex, getDefaultPicture } from '../../utils';
import { Socket } from 'socket.io-client';
import { IconCpu, IconSend } from '@tabler/icons-react';
import './Chat.css';

interface ChatProps {
  chat: ChatMessage[];
  scrollTimestamp: number;
  className?: string;
  hide?: boolean;
  socket: Socket | undefined;
}

export function Chat(props: ChatProps) {
  const [chatMsg, setChatMsg] = useState('');
  const [isNearBottom, setIsNearBottom] = useState(true);
  const messagesRef = useRef<HTMLDivElement>(null);

  const updateChatMsg = (e: any) => {
    setChatMsg(e.target.value);
  };

  const sendChatMsg = () => {
    if (!chatMsg || !props.socket) {
      return;
    }
    setChatMsg('');
    props.socket.emit('CMD:chat', chatMsg);
  };

  const isChatNearBottom = () => {
    return Boolean(
      messagesRef.current &&
        messagesRef.current.scrollHeight -
          messagesRef.current.scrollTop -
          messagesRef.current.offsetHeight <
          100,
    );
  };

  const onScroll = () => {
    setIsNearBottom(isChatNearBottom());
  };

  const scrollToBottom = () => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
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
    if (isChatNearBottom() || props.scrollTimestamp != null) {
      scrollToBottom();
    }
  }, [props.scrollTimestamp, props.chat]);
  return (
    <div
      className={props.className}
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
        <div className="chatMessages">
          {props.chat.map((msg) => (
            <ChatMessage key={msg.timestamp + msg.id} {...msg} />
          ))}
          {/* <div ref={this.messagesEndRef} /> */}
        </div>
        {!isNearBottom && (
          <Button
            size="xs"
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
      <TextInput
        style={{ marginTop: '8px' }}
        onKeyDown={(e: any) => e.key === 'Enter' && sendChatMsg()}
        onChange={updateChatMsg}
        value={chatMsg}
        rightSection={
          <ActionIcon radius="md" onClick={sendChatMsg}>
            <IconSend size={20} />
          </ActionIcon>
        }
        placeholder="Enter a message..."
      />
    </div>
  );
}

const ChatMessage = ({
  id,
  name,
  timestamp,
  cmd,
  msg,
  bot,
}: {
  id: string;
  name?: string;
  timestamp: string;
  cmd: string;
  msg: string;
  bot?: boolean;
}) => {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <Avatar
        src={bot ? undefined : getDefaultPicture(name ?? '', getColorHex(id))}
      >
        {bot ? <IconCpu /> : null}
      </Avatar>
      <div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end' }}>
          <div className="light username">{name || id}</div>
          <div className="dark timestamp">
            <div title={new Date(timestamp).toDateString()}>
              {new Date(timestamp).toLocaleTimeString()}
            </div>
          </div>
        </div>
        <div className="light system">{cmd && formatMessage(cmd, msg)}</div>
        <div className="light message">{!cmd && msg}</div>
      </div>
    </div>
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
