import React from 'react';
import { Button, Comment, Icon, Input, Segment } from 'semantic-ui-react';

import { getColorHex, getDefaultPicture } from '../../utils';

interface ChatProps {
  chat: ChatMessage[];
  scrollTimestamp: number;
  className?: string;
  hide?: boolean;
  sendChatMessage: (msg: string) => void;
}

export class Chat extends React.Component<ChatProps> {
  public state = { chatMsg: '', isNearBottom: true };
  messagesRef = React.createRef<HTMLDivElement>();

  componentDidMount() {
    this.scrollToBottom();
    this.messagesRef.current?.addEventListener('scroll', this.onScroll);
  }

  componentDidUpdate(prevProps: ChatProps) {
    if (this.props.scrollTimestamp !== prevProps.scrollTimestamp) {
      if (prevProps.scrollTimestamp === 0 || this.state.isNearBottom) {
        this.scrollToBottom();
      }
    }
  }

  updateChatMsg = (e: any, data: { value: string }) => {
    this.setState({ chatMsg: data.value });
  };

  sendChatMsg = () => {
    if (!this.state.chatMsg) {
      return;
    }
    this.setState({ chatMsg: '' });
    this.props.sendChatMessage(this.state.chatMsg);
  };

  onScroll = () => {
    this.setState({ isNearBottom: this.isChatNearBottom() });
  };

  isChatNearBottom = () => {
    return (
      this.messagesRef.current &&
      this.messagesRef.current.scrollHeight -
        this.messagesRef.current.scrollTop -
        this.messagesRef.current.offsetHeight <
        100
    );
  };

  scrollToBottom = () => {
    if (this.messagesRef.current) {
      this.messagesRef.current.scrollTop =
        this.messagesRef.current.scrollHeight;
    }
  };

  formatMessage = (cmd: string, msg: string): React.ReactNode | string => {
    if (cmd === 'judge') {
      const { id, correct, answer, delta, name, confidence } = JSON.parse(msg);
      return (
        <span
          style={{ color: correct ? '#21ba45' : '#db2828' }}
        >{`ruled ${name} ${correct ? 'correct' : 'incorrect'}: ${answer} (${
          delta >= 0 ? '+' : ''
        }${delta}) ${confidence != null ? `(${(confidence * 100).toFixed(0)}% conf.)` : ''}`}</span>
      );
    } else if (cmd === 'answer') {
      return `Correct answer: ${msg}`;
    }
    return cmd;
  };

  render() {
    return (
      <Segment
        className={this.props.className}
        inverted
        style={{
          display: this.props.hide ? 'none' : 'flex',
          flexDirection: 'column',
          flexGrow: '1',
          minHeight: 0,
          marginTop: 0,
          marginBottom: 0,
        }}
      >
        <div
          className="chatContainer"
          ref={this.messagesRef}
          style={{ position: 'relative' }}
        >
          <Comment.Group>
            {this.props.chat.map((msg) => (
              <ChatMessage
                key={msg.timestamp + msg.id}
                {...msg}
                formatMessage={this.formatMessage}
              />
            ))}
            {/* <div ref={this.messagesEndRef} /> */}
          </Comment.Group>
          {!this.state.isNearBottom && (
            <Button
              size="tiny"
              onClick={this.scrollToBottom}
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
          onKeyPress={(e: any) => e.key === 'Enter' && this.sendChatMsg()}
          onChange={this.updateChatMsg}
          value={this.state.chatMsg}
          icon={
            <Icon
              onClick={this.sendChatMsg}
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
}

const ChatMessage = ({
  id,
  name,
  timestamp,
  cmd,
  msg,
  formatMessage,
}: any) => {
  return (
    <Comment>
      <Comment.Avatar src={getDefaultPicture(name, getColorHex(id))} />
      <Comment.Content>
        <Comment.Author as="a" className="light">
          {name || id}
        </Comment.Author>
        <Comment.Metadata className="dark">
          <div title={new Date(timestamp).toDateString()}>{new Date(timestamp).toLocaleTimeString()}</div>
        </Comment.Metadata>
        <Comment.Text className="light system">
          {cmd && formatMessage(cmd, msg)}
        </Comment.Text>
        <Comment.Text className="light">{!cmd && msg}</Comment.Text>
      </Comment.Content>
    </Comment>
  );
};
