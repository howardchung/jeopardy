import React, { useEffect, useState } from 'react';
import {
  Button,
  Label,
  Input,
  Icon,
  Dropdown,
  Popup,
  Modal,
  Table,
  TableRow,
  TableCell,
  TableHeader,
  TableHeaderCell,
  Checkbox,
  Header,
  SemanticCOLORS,
} from 'semantic-ui-react';
import './Jeopardy.css';
import {
  getDefaultPicture,
  getColorHex,
  shuffle,
  getColor,
  generateName,
  serverPath,
  getOrCreateClientId,
} from '../../utils';
import { io, type Socket } from 'socket.io-client';
import ReactMarkdown from 'react-markdown';
import { type PublicGameState } from '../../../server/gamestate';
import { cyrb53 } from '../../../server/hash';

const dailyDouble = new Audio('/jeopardy/jeopardy-daily-double.mp3');
const boardFill = new Audio('/jeopardy/jeopardy-board-fill.mp3');
const think = new Audio('/jeopardy/jeopardy-think.mp3');
const timesUp = new Audio('/jeopardy/jeopardy-times-up.mp3');
const rightAnswer = new Audio('/jeopardy/jeopardy-rightanswer.mp3');

type GameSettings = {
  answerTimeout?: number;
  finalTimeout?: number;
  makeMeHost?: boolean;
  allowMultipleCorrect?: boolean;
  enableAIJudge?: boolean;
};

const loadSavedSettings = (): GameSettings => {
  try {
    const saved = window.localStorage.getItem('jeopardy-gameSettings');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.log(e);
  }
  return {};
};

// room ID from url
let roomId = '/default';
const urlParams = new URLSearchParams(window.location.search);
const query = urlParams.get('game');
if (query) {
  roomId = '/' + query;
}

export class Jeopardy extends React.Component<{
  participants: User[];
  chat: ChatMessage[];
  updateName: (name: string) => void;
  setSocket: (socket: Socket | undefined) => void;
  setParticipants: (users: User[]) => void;
  setScrollTimestamp: (ts: number) => void;
  setChat: (chat: ChatMessage[]) => void;
}> {
  public state = {
    game: undefined as PublicGameState | undefined,
    isIntroPlaying: false,
    localAnswer: '',
    localWager: '',
    localAnswerSubmitted: false,
    localWagerSubmitted: false,
    localEpNum: '',
    categoryMask: Array(6).fill(true),
    categoryReadTime: 0,
    clueMask: {} as any,
    readingDisabled: false,
    buzzFrozen: false,
    showCustomModal: false,
    showJudgingModal: false,
    showSettingsModal: false,
    settings: loadSavedSettings(),
    overlayMsg: '',
  };
  buzzLock = 0;
  socket: Socket | undefined = undefined;

  async componentDidMount() {
    window.speechSynthesis.getVoices();

    document.onkeydown = this.onKeydown;

    this.setState({
      readingDisabled: Boolean(
        window.localStorage.getItem('jeopardy-readingDisabled'),
      ),
    });
    const socket = io(serverPath + roomId, {
      transports: ['websocket'],
      query: {
        clientId: getOrCreateClientId(),
      },
    });
    this.socket = socket;
    this.props.setSocket(socket);
    socket.on('connect', async () => {
      // Load username from localstorage
      let userName = window.localStorage.getItem('watchparty-username');
      this.props.updateName(userName || (await generateName()));
    });
    socket.on('connect_error', (err: any) => {
      console.error(err);
      if (err.message === 'Invalid namespace') {
        this.setState({ overlayMsg: "Couldn't load this room." });
      }
    });
    socket.on('REC:chat', (data: ChatMessage) => {
      if (document.visibilityState && document.visibilityState !== 'visible') {
        new Audio('/clearly.mp3').play();
      }
      // There may be race condition issues if we append using [...this.state.chat, data]
      this.props.chat.push(data);
      this.props.setChat(this.props.chat);
      this.props.setScrollTimestamp(Number(new Date()));
    });
    socket.on('roster', (data: User[]) => {
      this.props.setParticipants(data);
    });
    socket.on('chatinit', (data: any) => {
      this.props.setChat(data);
      this.props.setScrollTimestamp(0);
    });
    socket.on('JPD:state', (game: PublicGameState) => {
      this.setState({ game, localEpNum: game.epNum });
    });
    // socket.on('JPD:playIntro', () => {
    //   this.playIntro();
    // });
    socket.on('JPD:playTimesUp', () => {
      timesUp.play();
    });
    socket.on('JPD:playDailyDouble', () => {
      dailyDouble.volume = 0.5;
      dailyDouble.play();
    });
    socket.on('JPD:playFinalJeopardy', async () => {
      think.volume = 0.5;
      think.play();
    });
    socket.on('JPD:playRightanswer', () => {
      rightAnswer.play();
    });
    // socket.on('JPD:playMakeSelection', () => {
    //   if (this.state.game.picker) {
    //     const selectionText = [
    //       'Make a selection, {name}',
    //       'You have command of the board, {name}',
    //       'Pick a clue, {name}',
    //       'Select a category, {name}',
    //       'Go again, {name}',
    //     ];
    //     const random =p
    //       selectionText[Math.floor(Math.random() * selectionText.length)];
    //     this.sayText(
    //       random.replace('{name}', this.state.game.picker)
    //     );
    //   }
    // });
    socket.on('JPD:playClue', async (qid: string, text: string) => {
      this.setState({
        localAnswer: '',
        localWager: '',
        localWagerSubmitted: false,
        localAnswerSubmitted: false,
      });
      // Read the question
      // console.log('JPD:playClue', text);
      // Remove parenthetical starts and blanks
      await this.sayText(text.replace(/^\(.*\)/, '').replace(/_+/g, ' blank '));
    });
    socket.on('JPD:playCategories', async () => {
      const now = Date.now();
      const clueMask: any = {};
      const clueMaskOrder = [];
      for (let i = 1; i <= 6; i++) {
        for (let j = 1; j <= 5; j++) {
          clueMask[`${i}_${j}`] = true;
          clueMaskOrder.push(`${i}_${j}`);
        }
      }
      this.setState({
        categoryMask: Array(6).fill(false),
        categoryReadTime: now,
        clueMask,
      });
      // Run board intro sequence
      // Play the fill sound
      boardFill.play();
      // Randomly choose ordering of the 30 clues
      // Split into 6 sets of 5
      // Each half second show another set of 5
      shuffle(clueMaskOrder);
      const clueSets = [];
      for (let i = 0; i < clueMaskOrder.length; i += 5) {
        clueSets.push(clueMaskOrder.slice(i, i + 5));
      }
      for (let i = 0; i < clueSets.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        clueSets[i].forEach((clue) => delete this.state.clueMask[clue]);
        this.setState({ clueMask: this.state.clueMask });
      }
      // Reveal and read categories
      const categories = this.getCategories();
      for (let i = 0; i < this.state.categoryMask.length; i++) {
        if (this.state.categoryReadTime !== now) {
          continue;
        }
        let newMask: Boolean[] = [...this.state.categoryMask];
        newMask[i] = true;
        this.setState({ categoryMask: newMask });
        await Promise.any([
          this.sayText(categories[i]),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    });
  }

  componentWillUnmount() {
    document.removeEventListener('keydown', this.onKeydown);
    this.socket?.close();
    this.socket = undefined;
    this.props.setSocket(undefined);
  }

  async componentDidUpdate(prevProps: any, prevState: any) {
    if (!prevState.game?.currentQ && this.state.game?.currentQ) {
      // Run growing clue animation
      const clue = document.getElementById(
        'clueContainerContainer',
      ) as HTMLElement;
      const board = document.getElementById('board') as HTMLElement;
      const box = document.getElementById(
        this.state.game?.currentQ,
      ) as HTMLElement;
      clue.style.position = 'absolute';
      clue.style.left = box.offsetLeft + 'px';
      clue.style.top = box.offsetTop + 'px';
      setTimeout(() => {
        clue.style.left = board.scrollLeft + 'px';
        clue.style.top = '0px';
        clue.style.transform = 'scale(1)';
      }, 1);
    }
  }

  onKeydown = (e: any) => {
    if (!document.activeElement || document.activeElement.tagName === 'BODY') {
      if (e.key === ' ') {
        e.preventDefault();
        this.onBuzz();
      }
      if (e.key === 'p') {
        e.preventDefault();
        if (this.state.game?.canBuzz) {
          this.submitAnswer(null);
        }
      }
    }
  };

  newGame = async (
    options: {
      number?: string;
      filter?: string;
    },
    customGame?: string,
  ) => {
    this.setState({ game: null });
    // optionally send an episode number or game type filter
    // combine with other custom settings configured by user
    const combined: GameOptions = {
      number: options.number,
      filter: options.filter,
      ...this.state.settings,
    };
    this.socket?.emit('JPD:start', combined, customGame);
  };

  customGame = () => {
    // Create an input element
    const inputElement = document.createElement('input');

    // Set its type to file
    inputElement.type = 'file';

    // Set accept to the file types you want the user to select.
    // Include both the file extension and the mime type
    // inputElement.accept = accept;

    // set onchange event to call callback when user has selected file
    inputElement.addEventListener('change', () => {
      const file = inputElement.files![0];
      // Read the file
      const reader = new FileReader();
      reader.readAsText(file);
      reader.onload = (e) => {
        let content = e.target?.result;
        this.newGame({}, content as string);
        this.setState({ showCustomModal: false });
      };
    });

    // dispatch a click event to open the file dialog
    inputElement.dispatchEvent(new MouseEvent('click'));
  };

  // playIntro = async () => {
  //   this.setState({ isIntroPlaying: true });
  //   document.getElementById('intro')!.innerHTML = '';
  //   let introVideo = document.createElement('video');
  //   let introMusic = new Audio('/jeopardy/jeopardy-intro-full.ogg');
  //   document.getElementById('intro')?.appendChild(introVideo);
  //   introVideo.muted = true;
  //   introVideo.src = '/jeopardy/jeopardy-intro-video.mp4';
  //   introVideo.play();
  //   introVideo.style.width = '100%';
  //   introVideo.style.height = '100%';
  //   introVideo.style.backgroundColor = '#000000';
  //   introMusic.volume = 0.5;
  //   introMusic.play();
  //   setTimeout(async () => {
  //     await this.sayText('This is Jeopardy!');
  //     await new Promise((resolve) => setTimeout(resolve, 1000));
  //     await this.sayText("Here are today's contestants.");
  //     await new Promise((resolve) => setTimeout(resolve, 1000));
  //     for (let i = 0; i < this.props.participants.length; i++) {
  //       const p = this.props.participants[i];
  //       const name = p.name;
  //       const player = document.createElement('img');
  //       player.src =
  //         getDefaultPicture(p.name, getColorHex(p.id));
  //       player.style.width = '200px';
  //       player.style.height = '200px';
  //       player.style.position = 'absolute';
  //       player.style.margin = 'auto';
  //       player.style.top = '0px';
  //       player.style.bottom = '0px';
  //       player.style.left = '0px';
  //       player.style.right = '0px';
  //       document.getElementById('intro')!.appendChild(player);
  //       // maybe we can look up the location by IP?
  //       await this.sayText('A person from somewhere, ' + name);
  //       await new Promise((resolve) => setTimeout(resolve, 1000));
  //       document.getElementById('intro')!.removeChild(player);
  //     }
  //     await this.sayText(
  //       'And now, here is the host of Jeopardy, your computer!'
  //     );
  //     await new Promise((resolve) => setTimeout(resolve, 1000));
  //     introMusic.pause();
  //     introVideo.pause();
  //     introVideo = null as any;
  //     introMusic = null as any;
  //     document.getElementById('intro')!.innerHTML = '';
  //     this.setState({ isIntroPlaying: false });
  //   }, 10000);
  // };

  sayText = async (text: string) => {
    if (this.state.readingDisabled) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    }
    if (text.startsWith('!')) {
      // This is probably markdown
      return;
    }
    // if enabled, attempt using pregen AI voice
    // Always checking first is kind of slow due to http request needed
    if (this.state.game?.enableAIVoices) {
      try {
        await new Promise(async (resolve, reject) => {
          const hash = cyrb53(text).toString();
          const aiVoice = new Audio(
            this.state.game?.enableAIVoices +
              '/gradio_api/file=audio/output/{hash}.mp3'.replace(
                '{hash}',
                hash,
              ),
          );
          aiVoice.onended = resolve;
          aiVoice.onerror = reject;
          try {
            await aiVoice.play();
          } catch (e) {
            reject(e);
          }
        });
        return;
      } catch (e) {
        console.log(e);
      }
    }
    // If we errored, fallback to browser TTS
    let isIOS = /iPad|iPhone|iPod/.test(navigator.platform);
    if (isIOS) {
      // on iOS speech synthesis just never returns
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    }
    await new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const utterThis = new SpeechSynthesisUtterance(text);
      // let retryCount = 0;
      // while (speechSynthesis.getVoices().length === 0 && retryCount < 3) {
      //   retryCount += 1;
      //   await new Promise((resolve) => setTimeout(resolve, 500));
      // }
      let voices = window.speechSynthesis.getVoices();
      let target = voices.find(
        (voice) => voice.name === 'Google UK English Male',
      );
      if (target) {
        utterThis.voice = target;
      }
      window.speechSynthesis.speak(utterThis);
      utterThis.onend = resolve;
      utterThis.onerror = resolve;
    });
  };

  pickQ = (id: string) => {
    this.socket?.emit('JPD:pickQ', id);
  };

  submitWager = () => {
    this.socket?.emit('JPD:wager', this.state.localWager);
    this.setState({ localWager: '', localWagerSubmitted: true });
  };

  submitAnswer = (answer = null) => {
    if (!this.state.localAnswerSubmitted) {
      this.socket?.emit(
        'JPD:answer',
        this.state.game?.currentQ,
        answer || this.state.localAnswer,
      );
      this.setState({ localAnswer: '', localAnswerSubmitted: true });
    }
  };

  judgeAnswer = (id: string, correct: boolean | null) => {
    this.socket?.emit('JPD:judge', {
      currentQ: this.state.game?.currentQ,
      id,
      correct,
    });
  };

  bulkJudgeAnswer = (data: { id: string; correct: boolean | null }[]) => {
    this.socket?.emit(
      'JPD:bulkJudge',
      data.map((d) => ({ ...d, currentQ: this.state.game?.currentQ })),
    );
  };

  getCategories = () => {
    const game = this.state.game;
    if (!game || !game.board) {
      return [];
    }
    let categories: string[] = Array(6).fill('');
    Object.keys(game.board).forEach((key) => {
      const col = Number(key.split('_')[0]) - 1;
      categories[col] = game.board[key].category;
    });
    return categories;
  };

  getWinners = () => {
    const max =
      Math.max(...Object.values<number>(this.state.game?.scores || {})) || 0;
    return this.props.participants
      .filter((p) => (this.state.game?.scores[p.id] || 0) === max)
      .map((p) => p.id);
  };

  getBuzzOffset = (id: string) => {
    if (!this.state.game?.buzzUnlockTS) {
      return 0;
    }
    return this.state.game?.buzzes[id] - this.state.game?.buzzUnlockTS;
  };

  onBuzz = () => {
    const game = this.state.game;
    if (game?.canBuzz && !this.buzzLock && !this.state.buzzFrozen) {
      this.socket?.emit('JPD:buzz');
    } else {
      // Freeze the buzzer for 0.25 seconds
      // setState takes a little bit, so also set a local var to prevent spam
      const now = Date.now();
      this.buzzLock = now;
      this.setState({ buzzFrozen: true });
      setTimeout(() => {
        if (this.buzzLock === now) {
          this.setState({ buzzFrozen: false });
          this.buzzLock = 0;
        }
      }, 250);
    }
  };

  saveSettings = (settings: GameSettings) => {
    // serialize to localStorage so settings persist on reload
    window.localStorage.setItem(
      'jeopardy-gameSettings',
      JSON.stringify(settings),
    );
    // update state
    this.setState({ settings });
  };

  render() {
    const game = this.state.game;
    const categories = this.getCategories();
    const participants = this.props.participants;
    const canJudge = !game?.host || this.socket?.id === game?.host;
    return (
      <>
        {this.state.showCustomModal && (
          <Modal open onClose={() => this.setState({ showCustomModal: false })}>
            <Modal.Header>Custom Game</Modal.Header>
            <Modal.Content>
              <Modal.Description>
                <div>
                  You can create and play a custom game by uploading a data
                  file. Download the example and customize with your own
                  questions and answers.
                  <div>
                    <Button
                      color="orange"
                      icon
                      labelPosition="left"
                      href={`./example.csv`}
                      download="example.csv"
                    >
                      <Icon name="download" />
                      Download Example .csv
                    </Button>
                  </div>
                </div>
                <hr />
                <div>Once you're done, upload your file:</div>
                <div>
                  <Button
                    onClick={() => this.customGame()}
                    icon
                    labelPosition="left"
                    color="purple"
                  >
                    <Icon name="upload" />
                    Upload
                  </Button>
                </div>
              </Modal.Description>
            </Modal.Content>
          </Modal>
        )}
        {this.state.showJudgingModal && (
          <BulkJudgeModal
            game={game}
            participants={participants}
            bulkJudge={this.bulkJudgeAnswer}
            onClose={() => this.setState({ showJudgingModal: false })}
            getBuzzOffset={this.getBuzzOffset}
          />
        )}
        {this.state.showSettingsModal && (
          <SettingsModal
            onClose={() => this.setState({ showSettingsModal: false })}
            onSubmit={this.saveSettings}
            settings={this.state.settings}
          />
        )}
        {this.state.overlayMsg && <ErrorModal error={this.state.overlayMsg} />}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            gap: '4px',
          }}
        >
          {
            <React.Fragment>
              {
                <div style={{ display: 'flex', flexGrow: 1 }}>
                  <div
                    id="board"
                    className={`board ${
                      this.state.game?.currentQ ? 'currentQ' : ''
                    }`}
                  >
                    {this.state.isIntroPlaying && <div id="intro" />}
                    {categories.map((cat, i) => (
                      <div key={i} className="category box">
                        {this.state.categoryMask[i] ? cat : ''}
                      </div>
                    ))}
                    {Array.from(Array(5)).map((_, i) => {
                      return (
                        <React.Fragment key={i}>
                          {categories.map((cat, j) => {
                            const id = `${j + 1}_${i + 1}`;
                            const clue = game?.board[id];
                            return (
                              <div
                                key={id}
                                id={id}
                                onClick={
                                  clue ? () => this.pickQ(id) : undefined
                                }
                                className={`${clue ? 'value' : ''} box`}
                              >
                                {!this.state.clueMask[id] && clue
                                  ? clue.value
                                  : ''}
                              </div>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                    {game && Boolean(game.currentQ) && (
                      <div
                        id="clueContainerContainer"
                        className="clueContainerContainer"
                      >
                        <div
                          id="clueContainer"
                          className={`clueContainer ${
                            game.currentDailyDouble && game.waitingForWager
                              ? 'dailyDouble'
                              : ''
                          }`}
                        >
                          <div className="category" style={{ height: '30px' }}>
                            {game.board[game.currentQ] &&
                              game.board[game.currentQ].category}
                          </div>
                          <div className="category" style={{ height: '30px' }}>
                            {Boolean(game.currentValue) && game.currentValue}
                          </div>
                          {
                            <div className={`clue`}>
                              <ReactMarkdown
                                components={{
                                  //This custom renderer changes how images are rendered
                                  //we use it to constrain the max width of an image to its container
                                  img: ({
                                    alt,
                                    src,
                                    title,
                                  }: {
                                    alt?: string;
                                    src?: string;
                                    title?: string;
                                  }) => (
                                    <img
                                      alt={alt}
                                      src={src}
                                      title={title}
                                      style={{
                                        maxWidth: '80%',
                                        maxHeight: '350px',
                                      }}
                                    />
                                  ),
                                }}
                              >
                                {game.board[game.currentQ] &&
                                  game.board[game.currentQ].question}
                              </ReactMarkdown>
                            </div>
                          }
                          <div className="" style={{ height: '60px' }}>
                            {!game.currentAnswer &&
                            this.socket &&
                            !game.buzzes[this.socket.id!] &&
                            !game.submitted[this.socket.id!] &&
                            !game.currentDailyDouble &&
                            game.round !== 'final' ? (
                              <div style={{ display: 'flex' }}>
                                <Button
                                  disabled={this.state.buzzFrozen}
                                  color={game.canBuzz ? 'green' : 'grey'}
                                  size="huge"
                                  onClick={this.onBuzz}
                                  icon
                                  labelPosition="left"
                                >
                                  <Icon
                                    name={game.canBuzz ? 'lightbulb' : 'lock'}
                                  />
                                  Buzz
                                </Button>
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: '0px',
                                    right: '0px',
                                    zIndex: 1,
                                  }}
                                >
                                  <Button
                                    disabled={this.state.buzzFrozen}
                                    color={game.canBuzz ? 'red' : 'grey'}
                                    onClick={() => {
                                      if (game.canBuzz) {
                                        this.submitAnswer(null);
                                      }
                                    }}
                                    icon
                                    labelPosition="left"
                                  >
                                    <Icon
                                      name={game.canBuzz ? 'forward' : 'lock'}
                                    />
                                    Pass
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                            {!game.currentAnswer &&
                            !this.state.localAnswerSubmitted &&
                            this.socket &&
                            game.buzzes[this.socket.id!] &&
                            game.questionEndTS ? (
                              <Input
                                autoFocus
                                label="Answer"
                                value={this.state.localAnswer}
                                onChange={(e) =>
                                  this.setState({ localAnswer: e.target.value })
                                }
                                onKeyPress={(e: any) =>
                                  e.key === 'Enter' && this.submitAnswer()
                                }
                                icon={
                                  <Icon
                                    onClick={() => this.submitAnswer()}
                                    name="arrow right"
                                    inverted
                                    circular
                                    link
                                  />
                                }
                              />
                            ) : null}
                            {game.waitingForWager &&
                            this.socket &&
                            game.waitingForWager[this.socket.id!] ? (
                              <Input
                                label={`Wager (${
                                  getWagerBounds(
                                    game.round,
                                    game.scores[this.socket.id!],
                                  ).minWager
                                } to ${
                                  getWagerBounds(
                                    game.round,
                                    game.scores[this.socket.id!],
                                  ).maxWager
                                })`}
                                value={this.state.localWager}
                                onChange={(e) =>
                                  this.setState({ localWager: e.target.value })
                                }
                                onKeyPress={(e: any) =>
                                  e.key === 'Enter' && this.submitWager()
                                }
                                icon={
                                  <Icon
                                    onClick={() => this.submitWager()}
                                    name="arrow right"
                                    inverted
                                    circular
                                    link
                                  />
                                }
                              />
                            ) : null}
                          </div>
                          <div className={`answer`} style={{ height: '30px' }}>
                            {game.currentAnswer}
                          </div>
                          {Boolean(game.playClueEndTS) && (
                            <TimerBar duration={game.playClueEndTS - game.serverTime} />
                          )}
                          {Boolean(game.questionEndTS) && (
                            <TimerBar
                              duration={game.questionEndTS - game.serverTime}
                              secondary
                              submitAnswer={this.submitAnswer}
                            />
                          )}
                          {Boolean(game.wagerEndTS) && (
                            <TimerBar
                              duration={game.wagerEndTS - game.serverTime}
                              secondary
                            />
                          )}
                          {game.canNextQ && (
                            <div
                              style={{
                                position: 'absolute',
                                top: '0px',
                                right: '0px',
                              }}
                            >
                              <Button
                                onClick={() => this.socket?.emit('JPD:skipQ')}
                                icon
                                labelPosition="left"
                              >
                                <Icon name="forward" />
                                Next
                              </Button>
                            </div>
                          )}
                          {game.currentAnswer && canJudge && (
                            <div
                              style={{
                                position: 'absolute',
                                bottom: '0px',
                                right: '0px',
                              }}
                            >
                              <Button
                                onClick={() =>
                                  this.setState({ showJudgingModal: true })
                                }
                                icon
                                labelPosition="left"
                              >
                                <Icon name="gavel" />
                                Bulk Judge
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {game && game.round === 'end' && (
                      <div id="endgame">
                        <h1 style={{ color: 'white' }}>Winner!</h1>
                        <div style={{ display: 'flex' }}>
                          {this.getWinners().map((winnerId: string) => (
                            <img
                              key={winnerId}
                              alt=""
                              style={{ width: '200px', height: '200px' }}
                              src={getDefaultPicture(
                                participants.find((p) => p.id === winnerId)
                                  ?.name ?? '',
                                getColorHex(winnerId),
                              )}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              }
              <div
                style={{ display: 'flex', overflowX: 'auto', flexShrink: 0 }}
              >
                {participants.map((p) => {
                  return (
                    <div key={p.id} className="scoreboard">
                      <div className="picture" style={{ position: 'relative' }}>
                        <img
                          alt=""
                          src={getDefaultPicture(
                            p.name ?? '',
                            getColorHex(p.id),
                          )}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '4px',
                            left: '0px',
                            width: '100%',
                            backgroundColor: '#' + getColorHex(p.id),
                            color: 'white',
                            borderRadius: '4px',
                            fontSize: '10px',
                            fontWeight: 700,
                            display: 'flex',
                          }}
                        >
                          <div
                            title={p.name || p.id}
                            style={{
                              width: '100%',
                              backdropFilter: 'brightness(80%)',
                              padding: '4px',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              display: 'inline-block',
                            }}
                          >
                            {p.name || p.id}
                          </div>
                        </div>
                        {game && p.id in game.wagers ? (
                          <div
                            style={{
                              position: 'absolute',
                              bottom: '8px',
                              right: '0px',
                            }}
                          >
                            <Label title="Wager" circular size="tiny">
                              {game.wagers[p.id] || 0}
                            </Label>
                          </div>
                        ) : null}
                        {game && (
                          <div className="icons">
                            {!game.picker || game.picker === p.id ? (
                              <Icon
                                title="Controlling the board"
                                name="pointing up"
                              />
                            ) : null}
                            {game.host && game.host === p.id ? (
                              <Icon title="Game host" name="star" />
                            ) : null}
                            {!p.connected ? (
                              <Icon
                                color="red"
                                title="Disconnected"
                                name="plug"
                              />
                            ) : null}
                          </div>
                        )}
                        {game &&
                        p.id === game.currentJudgeAnswer &&
                        canJudge ? (
                          <div className="judgeButtons">
                            <Popup
                              content="Correct"
                              trigger={
                                <Button
                                  onClick={() => this.judgeAnswer(p.id, true)}
                                  color="green"
                                  size="tiny"
                                  icon
                                  fluid
                                >
                                  <Icon name="check" />
                                </Button>
                              }
                            />
                            <Popup
                              content="Incorrect"
                              trigger={
                                <Button
                                  onClick={() => this.judgeAnswer(p.id, false)}
                                  color="red"
                                  size="tiny"
                                  icon
                                  fluid
                                >
                                  <Icon name="close" />
                                </Button>
                              }
                            />
                            <Popup
                              content="Skip"
                              trigger={
                                <Button
                                  onClick={() => this.judgeAnswer(p.id, null)}
                                  color="grey"
                                  size="tiny"
                                  icon
                                  fluid
                                >
                                  <Icon name="angle double right" />
                                </Button>
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                      <div
                        className={`points ${
                          game && game.scores[p.id] < 0 ? 'negative' : ''
                        }`}
                      >
                        {(game?.scores[p.id] || 0).toLocaleString()}
                      </div>
                      <div
                        className={`answerBox ${
                          game?.buzzes[p.id] ? 'buzz' : ''
                        } ${game?.judges[p.id] === false ? 'negative' : ''}`}
                      >
                        {game && game.answers[p.id]}
                        <div className="timeOffset">
                          {this.getBuzzOffset(p.id) &&
                          this.getBuzzOffset(p.id) > 0
                            ? `+${(this.getBuzzOffset(p.id) / 1000).toFixed(3)}`
                            : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  rowGap: '4px',
                }}
              >
                <Dropdown
                  button
                  className="icon"
                  labeled
                  icon="certificate"
                  text="New Game"
                >
                  <Dropdown.Menu>
                    {[
                      { key: 'all', value: null, text: 'Any' },
                      { key: 'kids', value: 'kids', text: 'Kids Week' },
                      { key: 'teen', value: 'teen', text: 'Teen Tournament' },
                      {
                        key: 'college',
                        value: 'college',
                        text: 'College Championship',
                      },
                      {
                        key: 'celebrity',
                        value: 'celebrity',
                        text: 'Celebrity Jeopardy',
                      },
                      {
                        key: 'teacher',
                        value: 'teacher',
                        text: 'Teachers Tournament',
                      },
                      {
                        key: 'champions',
                        value: 'champions',
                        text: 'Tournament of Champions',
                      },
                      {
                        key: 'custom',
                        value: 'custom',
                        text: 'Custom Game',
                      },
                    ].map((item) => (
                      <Dropdown.Item
                        key={item.key}
                        onClick={() => {
                          if (item.value === 'custom') {
                            this.setState({ showCustomModal: true });
                          } else {
                            this.newGame({ filter: item.value ?? undefined });
                          }
                        }}
                      >
                        {item.text}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
                <Input
                  className="gameSelector"
                  style={{ marginRight: '.25em' }}
                  label="#"
                  value={this.state.localEpNum}
                  onChange={(e, data) =>
                    this.setState({ localEpNum: data.value })
                  }
                  onKeyPress={(e: any) =>
                    e.key === 'Enter' &&
                    this.newGame({ number: this.state.localEpNum })
                  }
                  icon={
                    <Icon
                      onClick={() =>
                        this.newGame({ number: this.state.localEpNum })
                      }
                      name="arrow right"
                      inverted
                      circular
                    />
                  }
                />
                {game && game.airDate && (
                  <Label
                    style={{ display: 'flex', alignItems: 'center' }}
                    color={
                      getColor(
                        (game && game.info) || 'regular',
                      ) as SemanticCOLORS
                    }
                    size="medium"
                  >
                    {new Date(game.airDate + 'T00:00').toLocaleDateString([], {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                    {game && game.info ? ' - ' + game.info : ''}
                  </Label>
                )}
                <Button
                  icon
                  labelPosition="left"
                  color={this.state.readingDisabled ? 'red' : 'green'}
                  onClick={() => {
                    const checked = !this.state.readingDisabled;
                    this.setState({ readingDisabled: checked });
                    if (checked) {
                      window.localStorage.setItem(
                        'jeopardy-readingDisabled',
                        '1',
                      );
                    } else {
                      window.localStorage.removeItem(
                        'jeopardy-readingDisabled',
                      );
                    }
                  }}
                >
                  <Icon name="book" />
                  {this.state.readingDisabled ? 'Reading off' : 'Reading on'}
                </Button>
                <Button
                  icon
                  labelPosition="left"
                  color={game?.enableAIJudge ? 'green' : 'red'}
                  onClick={() => {
                    this.socket?.emit(
                      'JPD:enableAiJudge',
                      !Boolean(game?.enableAIJudge),
                    );
                  }}
                >
                  <Icon name="lightbulb" />
                  {game?.enableAIJudge ? 'AI Judge on' : 'AI Judge off'}
                </Button>
                <Button
                  onClick={() => this.setState({ showSettingsModal: true })}
                  icon
                  labelPosition="left"
                >
                  <Icon name="cog" />
                  Settings
                </Button>
                {canJudge && (
                  <Button
                    onClick={() => this.socket?.emit('JPD:undo')}
                    icon
                    labelPosition="left"
                  >
                    <Icon name="undo" />
                    Undo Judge
                  </Button>
                )}
                {/* <Button
                  onClick={() => this.socket?.emit('JPD:cmdIntro')}
                  icon
                  labelPosition="left"
                  color="blue"
                >
                  <Icon name="film" />
                  Play Intro
                </Button> */}
              </div>
            </React.Fragment>
          }
          {false && process.env.NODE_ENV === 'development' && (
            <pre
              style={{ color: 'white', height: '200px', overflow: 'scroll' }}
            >
              {JSON.stringify(game, null, 2)}
            </pre>
          )}
        </div>
      </>
    );
  }
}

function TimerBar({duration, secondary, submitAnswer}: {
  duration: number;
  secondary?: boolean;
  submitAnswer?: Function;
}) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    requestAnimationFrame(() => {
      setWidth(100);
    });
    let submitTimeout: number | undefined;
    if (submitAnswer) {
      // Submit whatever's in the box 0.5s before expected timeout
      // Bit hacky, but to fix we either need to submit updates on each character
      // Or have a separate step where the server instructs all clients to submit whatever is in box and accepts it
      submitTimeout = window.setTimeout(
        submitAnswer,
        duration - 500,
      );
    }
    return () => {
      if (submitTimeout) {
        window.clearTimeout(submitTimeout);
      }
    }
  }, []);
  return (
    <div
      style={{
        position: 'absolute',
        bottom: '0px',
        left: '0px',
        height: '10px',
        width: width + '%',
        backgroundColor: secondary ? '#16AB39' : '#0E6EB8',
        transition: `${duration / 1000}s width linear`,
      }}
    />
  );
}

function getWagerBounds(round: string, score: number) {
  // User setting a wager for DD or final
  // Can bet up to current score, minimum of 1000 in single or 2000 in double, 0 in final
  let maxWager = 0;
  let minWager = 5;
  if (round === 'jeopardy') {
    maxWager = Math.max(score || 0, 1000);
  } else if (round === 'double') {
    maxWager = Math.max(score || 0, 2000);
  } else if (round === 'final') {
    minWager = 0;
    maxWager = Math.max(score || 0, 0);
  }
  return { minWager, maxWager };
}

const BulkJudgeModal = ({
  onClose,
  game,
  participants,
  bulkJudge,
}: {
  onClose: () => void;
  game: PublicGameState | undefined;
  participants: User[];
  bulkJudge: (judges: { id: string; correct: boolean | null }[]) => void;
  getBuzzOffset: (id: string) => number;
}) => {
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const distinctAnswers: string[] = Array.from(
    new Set(
      Object.values<string>(game?.answers ?? {}).map(
        (answer: string) => answer?.toLowerCase()?.trim(),
      ),
    ),
  );
  return (
    <Modal open onClose={onClose}>
      <Modal.Header>{game?.currentAnswer}</Modal.Header>
      <Modal.Content>
        <Table>
          <TableHeader>
            <TableHeaderCell>Answer</TableHeaderCell>
            <TableHeaderCell>Decision</TableHeaderCell>
            <TableHeaderCell>Responses</TableHeaderCell>
          </TableHeader>
          {distinctAnswers.map((answer) => {
            return (
              <TableRow>
                <TableCell>{answer}</TableCell>
                <TableCell>
                  <Dropdown
                    placeholder="Select"
                    value={decisions[answer]}
                    options={[
                      { key: 'correct', value: 'true', text: 'Correct' },
                      { key: 'incorrect', value: 'false', text: 'Incorrect' },
                      { key: 'skip', value: 'skip', text: 'Skip' },
                    ]}
                    onChange={(e, data) => {
                      const newDecisions = {
                        ...decisions,
                        [answer]: data.value as string,
                      };
                      setDecisions(newDecisions);
                    }}
                  ></Dropdown>
                </TableCell>
                <TableCell>
                  {participants
                    .filter(
                      (p) =>
                        game?.answers[p.id]?.toLowerCase()?.trim() === answer,
                    )
                    .map((p) => {
                      return (
                        <img
                          style={{ width: '30px' }}
                          alt=""
                          src={getDefaultPicture(
                            p.name ?? '',
                            getColorHex(p.id),
                          )}
                        />
                      );
                    })}
                </TableCell>
              </TableRow>
            );
          })}
        </Table>
      </Modal.Content>
      <Modal.Actions>
        <Button
          onClick={() => {
            const answers = Object.entries<string>(game?.answers || {});
            // Assemble the bulk judges
            const arr = answers.map((ans) => {
              // Look up the answer and decision
              const answer = ans[1]?.toLowerCase()?.trim();
              const decision = decisions[answer];
              return {
                id: ans[0],
                correct: decision === 'skip' ? null : JSON.parse(decision),
              };
            });
            bulkJudge(arr);
            // Close the modal
            onClose();
          }}
        >
          Bulk Judge
        </Button>
      </Modal.Actions>
    </Modal>
  );
};

const SettingsModal = ({
  onClose,
  onSubmit,
  settings,
}: {
  onClose: () => void;
  onSubmit: (settings: GameSettings) => void;
  settings: GameSettings;
}) => {
  const [answerTimeout, setAnswerTimeout] = useState<number | undefined>(
    settings.answerTimeout,
  );
  const [finalTimeout, setFinalTimeout] = useState<number | undefined>(
    settings.finalTimeout,
  );
  const [makeMeHost, setMakeMeHost] = useState<boolean | undefined>(
    settings.makeMeHost,
  );
  const [allowMultipleCorrect, setAllowMultipleCorrect] = useState<
    boolean | undefined
  >(settings.allowMultipleCorrect);
  const [enableAIJudge, setEnableAIJudge] = useState<boolean | undefined>(
    settings.enableAIJudge,
  );
  return (
    <Modal open onClose={onClose}>
      <Modal.Header>Settings</Modal.Header>
      <Modal.Content>
        <h4>Settings will be applied to any games you create.</h4>
        <div style={{ gap: '4px', display: 'flex', flexDirection: 'column' }}>
          <Checkbox
            checked={makeMeHost}
            onChange={(e, props) => setMakeMeHost(props.checked)}
            label="Make me the host (Only you will be able to select questions and make judging decisions)"
            toggle={true}
          />
          <Checkbox
            checked={allowMultipleCorrect}
            onChange={(e, props) => setAllowMultipleCorrect(props.checked)}
            label="Allow multiple correct answers (This also disables Daily Doubles and allows all players to pick the next question)"
            toggle={true}
          />
          <Checkbox
            checked={enableAIJudge}
            onChange={(e, props) => setEnableAIJudge(props.checked)}
            label="Enable AI judge by default"
            toggle={true}
          />
          <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
            <Input
              style={{ width: 60 }}
              type="number"
              value={answerTimeout}
              onChange={(e, data) => setAnswerTimeout(Number(data.value))}
              size="mini"
            />
            Seconds for regular answers and Daily Double wagers (Default: 20)
          </div>
          <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
            <Input
              style={{ width: 60 }}
              type="number"
              value={finalTimeout}
              onChange={(e, data) => setFinalTimeout(Number(data.value))}
              size="mini"
            />
            Seconds for Final Jeopardy answers and wagers (Default: 30)
          </div>
        </div>
      </Modal.Content>
      <Modal.Actions>
        <Button
          onClick={() => {
            const settings: GameSettings = {
              makeMeHost: Boolean(makeMeHost),
              allowMultipleCorrect: Boolean(allowMultipleCorrect),
              enableAIJudge: Boolean(enableAIJudge),
              answerTimeout: Number(answerTimeout),
              finalTimeout: Number(finalTimeout),
            };
            onSubmit(settings);
            onClose();
          }}
        >
          Save
        </Button>
      </Modal.Actions>
    </Modal>
  );
};

export const ErrorModal = ({ error }: { error: string }) => {
  return (
    <Modal inverted="true" basic open>
      <Header as="h1" style={{ textAlign: 'center' }}>
        {error}
      </Header>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Button
          primary
          size="huge"
          onClick={() => {
            window.location.href = '/';
          }}
          icon
          labelPosition="left"
        >
          <Icon name="home" />
          Go to home page
        </Button>
      </div>
    </Modal>
  );
};
