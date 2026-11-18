import React, { useEffect, useRef, useState } from "react";
import "./Jeopardy.css";
import {
  getDefaultPicture,
  getColorHex,
  shuffle,
  getColor,
  generateName,
  serverPath,
  getOrCreateClientId,
} from "../../utils";
import { io, type Socket } from "socket.io-client";
import { type PublicGameState } from "../../../server/gamestate";
import { cyrb53 } from "../../../server/hash";
import {
  IconArrowBackUp,
  IconBulb,
  IconCheck,
  IconCornerDownRight,
  IconDownload,
  IconEye,
  IconGavel,
  IconHandFinger,
  IconHome,
  IconLock,
  IconPlayerTrackNextFilled,
  IconPlug,
  IconRefresh,
  IconSettings,
  IconStarFilled,
  IconUpload,
  IconX,
} from "../Icons";

const dailyDouble = new Audio("/jeopardy/jeopardy-daily-double.mp3");
const boardFill = new Audio("/jeopardy/jeopardy-board-fill.mp3");
const think = new Audio("/jeopardy/jeopardy-think.mp3");
const timesUp = new Audio("/jeopardy/jeopardy-times-up.mp3");
const rightAnswer = new Audio("/jeopardy/jeopardy-rightanswer.mp3");

type GameSettings = {
  answerTimeout?: number;
  finalTimeout?: number;
  makeMeHost?: boolean;
  allowMultipleCorrect?: boolean;
};

const loadSavedSettings = (): GameSettings => {
  try {
    const saved = window.localStorage.getItem("jeopardy-gameSettings");
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.log(e);
  }
  return {};
};

// room ID from url
let roomId = "/default";
const urlParams = new URLSearchParams(window.location.search);
const query = urlParams.get("game");
if (query) {
  roomId = "/" + query;
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
    localAnswer: "",
    localWager: "",
    localEpNum: "",
    categoryMask: Array(6).fill(true),
    categoryReadTime: 0,
    clueMask: {} as any,
    readingDisabled: false,
    buzzFrozen: false,
    showCustomModal: false,
    showJudgingModal: false,
    showSettingsModal: false,
    settings: loadSavedSettings(),
    overlayMsg: "",
  };
  buzzLock = 0;
  socket: Socket | undefined = undefined;

  async componentDidMount() {
    window.speechSynthesis?.getVoices();

    document.addEventListener("keydown", this.onKeydown);

    this.setState({
      readingDisabled: Boolean(
        window.localStorage.getItem("jeopardy-readingDisabled"),
      ),
    });
    const socket = io(serverPath + roomId, {
      transports: ["websocket"],
      query: {
        clientId: getOrCreateClientId(),
      },
    });
    this.socket = socket;
    this.props.setSocket(socket);
    socket.on("connect", async () => {
      // Load username from localstorage
      let userName = window.localStorage.getItem("watchparty-username");
      this.props.updateName(userName || (await generateName()));
    });
    socket.on("connect_error", (err: any) => {
      console.error(err);
      if (err.message === "Invalid namespace") {
        this.setState({ overlayMsg: "Couldn't load this room." });
      } else {
        this.setState({ overlayMsg: err.message });
      }
    });
    socket.on("REC:chat", (data: ChatMessage) => {
      if (document.visibilityState && document.visibilityState !== "visible") {
        new Audio("/clearly.mp3").play();
      }
      // There may be race condition issues if we append using [...this.state.chat, data]
      this.props.chat.push(data);
      this.props.setChat(this.props.chat);
      this.props.setScrollTimestamp(Number(new Date()));
    });
    socket.on("roster", (data: User[]) => {
      this.props.setParticipants(data);
    });
    socket.on("chatinit", (data: any) => {
      this.props.setChat(data);
      this.props.setScrollTimestamp(0);
    });
    socket.on("JPD:state", (game: PublicGameState) => {
      this.setState({ game, localEpNum: game.epNum });
      if (!game.currentQ) {
        this.setState({ showJudgingModal: false });
      }
    });
    socket.on(
      "JPD:aiVoiceProgress",
      (aiVoiceProgress: { count: number; total: number } | undefined) => {
        this.setState((prevState: any) =>
          prevState.game
            ? { game: { ...prevState.game, aiVoiceProgress } }
            : null,
        );
      },
    );
    // socket.on('JPD:playIntro', () => {
    //   this.playIntro();
    // });
    socket.on("JPD:playTimesUp", () => {
      timesUp.play();
    });
    socket.on("JPD:playDailyDouble", () => {
      dailyDouble.volume = 0.5;
      dailyDouble.play();
    });
    socket.on("JPD:playFinalJeopardy", async () => {
      think.volume = 0.5;
      think.play();
    });
    socket.on("JPD:playRightanswer", () => {
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
    socket.on("JPD:playClue", async (qid: string, text: string) => {
      this.setState({
        localAnswer: "",
        localWager: "",
      });
      // Read the question
      // console.log('JPD:playClue', text);
      // Remove parenthetical starts and blanks
      await this.sayText(
        text.replace(/^\(.*\)/, "").replace(/_+/g, " blank ").trim(),
      );
    });
    socket.on("JPD:playCategories", async () => {
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
    document.removeEventListener("keydown", this.onKeydown);
    this.socket?.close();
    this.socket = undefined;
    this.props.setSocket(undefined);
  }

  async componentDidUpdate(prevProps: any, prevState: any) {
    if (!prevState.game?.currentQ && this.state.game?.currentQ) {
      // Run growing clue animation
      const clue = document.getElementById(
        "clueContainerContainer",
      ) as HTMLElement;
      const board = document.getElementById("board") as HTMLElement;
      const box = document.getElementById(
        this.state.game?.currentQ,
      ) as HTMLElement;
      clue.style.position = "absolute";
      clue.style.left = box.offsetLeft + "px";
      clue.style.top = box.offsetTop + "px";
      setTimeout(() => {
        clue.style.left = board.scrollLeft + "px";
        clue.style.top = "0px";
        clue.style.transform = "scale(1)";
      }, 1);
    }
    const judgeId = this.state.game?.currentJudgeAnswer;
    if (judgeId && prevState.game?.currentJudgeAnswer !== judgeId) {
      const strip = document.getElementById("scoreboardStrip");
      const card = document.getElementById(`scoreboard-${judgeId}`);
      if (strip && card) {
        const stripRect = strip.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        if (cardRect.left < stripRect.left || cardRect.right > stripRect.right) {
          const targetLeft =
            strip.scrollLeft +
            (cardRect.left - stripRect.left) -
            (stripRect.width - cardRect.width) / 2;
          strip.scrollTo({
            left: Math.max(0, targetLeft),
            behavior: "smooth",
          });
        }
      }
    }
  }

  onKeydown = (e: any) => {
    if (!document.activeElement || document.activeElement.tagName === "BODY") {
      if (e.key === " ") {
        e.preventDefault();
        this.onBuzz();
      }
      if (e.key === "p") {
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
    this.socket?.emit("JPD:start", combined, customGame);
  };

  customGame = () => {
    // Create an input element
    const inputElement = document.createElement("input");

    // Set its type to file
    inputElement.type = "file";

    // Set accept to the file types you want the user to select.
    // Include both the file extension and the mime type
    // inputElement.accept = accept;

    // set onchange event to call callback when user has selected file
    inputElement.addEventListener("change", () => {
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
    inputElement.dispatchEvent(new MouseEvent("click"));
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
    if (text.startsWith("!") || text.startsWith("http")) {
      // This is probably markdown or image
      return;
    }
    // if enabled, attempt using AI voice served from the Python RVC server
    if (this.state.game?.enableAIVoices) {
      try {
        await new Promise(async (resolve, reject) => {
          const hash = cyrb53(text).toString();
          const rvcBase = String(this.state.game?.enableAIVoices).replace(
            /\/+$/,
            "",
          );
          const aiVoice = new Audio(
            `${rvcBase}/audio/${hash}.mp3?text=${encodeURIComponent(text)}`,
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
      window.speechSynthesis?.cancel();
      const utterThis = new SpeechSynthesisUtterance(text);
      // let retryCount = 0;
      // while (speechSynthesis.getVoices().length === 0 && retryCount < 3) {
      //   retryCount += 1;
      //   await new Promise((resolve) => setTimeout(resolve, 500));
      // }
      let voices = window.speechSynthesis?.getVoices();
      let target = voices.find(
        (voice) => voice.name === "Google UK English Male",
      );
      if (target) {
        utterThis.voice = target;
      }
      window.speechSynthesis?.speak(utterThis);
      utterThis.onend = resolve;
      utterThis.onerror = resolve;
    });
  };

  pickQ = (id: string) => {
    this.socket?.emit("JPD:pickQ", id);
  };

  submitWager = (value?: string) => {
    this.socket?.emit("JPD:wager", value || this.state.localWager);
    this.setState({ localWager: "" });
  };

  submitAnswer = (answer = null) => {
    this.socket?.emit(
      "JPD:answer",
      this.state.game?.currentQ,
      answer || this.state.localAnswer,
    );
    this.setState({ localAnswer: "" });
  };

  judgeAnswer = (id: string, correct: boolean | null) => {
    this.socket?.emit("JPD:judge", {
      currentQ: this.state.game?.currentQ,
      id,
      correct,
    });
  };

  getCategories = () => {
    const game = this.state.game;
    if (!game || !game.board) {
      return [];
    }
    let categories: string[] = Array(6).fill("");
    Object.keys(game.board).forEach((key) => {
      const col = Number(key.split("_")[0]) - 1;
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
      this.socket?.emit("JPD:buzz");
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
      "jeopardy-gameSettings",
      JSON.stringify(settings),
    );
    // update state
    this.setState({ settings });
  };

  render() {
    const clientId = getOrCreateClientId();
    const game = this.state.game;
    const categories = this.getCategories();
    const participants = this.props.participants;
    const isSpectator = participants.find((p) => p.id === clientId)?.spectator;
    const canJudge = !isSpectator && (!game?.host || clientId === game?.host);
    const JudgeButtons = ({ id }: { id: string }) => {
      return game && id === game.currentJudgeAnswer && canJudge ? (
        <div className="judgeButtons">
          <button
            type="button"
            className="ui-action-icon ui-action-icon-green"
            onClick={() => this.judgeAnswer(id, true)}
            title="Correct"
          >
            <IconCheck name="check" />
          </button>
          <button
            type="button"
            className="ui-action-icon ui-action-icon-red"
            onClick={() => this.judgeAnswer(id, false)}
            title="Incorrect"
          >
            <IconX name="close" />
          </button>
          <button
            type="button"
            className="ui-action-icon ui-action-icon-grey"
            onClick={() => this.judgeAnswer(id, null)}
            title="Skip"
          >
            <IconPlayerTrackNextFilled name="angle double right" />
          </button>
        </div>
      ) : null;
    };

    const BulkJudgeModal = ({
      onClose,
      game,
      participants,
      getBuzzOffset,
    }: {
      onClose: () => void;
      game: PublicGameState | undefined;
      participants: User[];
      getBuzzOffset: (id: string) => number;
    }) => {
      return (
        <Modal size="xl" opened onClose={onClose} title={game?.currentAnswer}>
          <table className="ui-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Score</th>
                <th>Wager</th>
                <th>Time</th>
                <th>Decision</th>
                <th>Answer</th>
              </tr>
            </thead>
            <tbody>
              {game?.judgeArr.map((clientId) => {
                return (
                  <tr key={clientId}>
                    <td>
                      {participants.find((p) => p.id === clientId)?.name ??
                        clientId}
                    </td>
                    <td>{game.scores[clientId]}</td>
                    <td>{game.wagers[clientId] ?? game.currentValue}</td>
                    <td>
                      {getBuzzOffset(clientId) && getBuzzOffset(clientId) > 0
                        ? `+${(getBuzzOffset(clientId) / 1000).toFixed(3)}`
                        : ""}
                    </td>
                    <td>
                      <div
                        style={{
                          position: "relative",
                          minHeight: "28px",
                          minWidth: "100px",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                        }}
                      >
                        <JudgeButtons id={clientId} />
                      </div>
                    </td>
                    <td>{game.answers[clientId]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Modal>
      );
    };
    return (
      <>
        {this.state.showCustomModal && (
          <Modal
            opened
            onClose={() => this.setState({ showCustomModal: false })}
            title="Custom Game"
          >
            <div>
              You can create and play a custom game by uploading a data file.
              Download the example and customize with your own questions and
              answers.
              <div style={{ marginTop: "8px" }}>
                <a
                  className="ui-btn ui-btn-orange"
                  href={`./example.csv`}
                  download="example.csv"
                >
                  <IconDownload />
                  Download example.csv
                </a>
              </div>
            </div>
            <hr />
            <div>Once you're done, upload your file:</div>
            <div style={{ marginTop: "8px" }}>
              <button
                type="button"
                className="ui-btn ui-btn-purple"
                onClick={() => this.customGame()}
              >
                <IconUpload />
                Upload
              </button>
            </div>
          </Modal>
        )}
        {this.state.showJudgingModal && (
          <BulkJudgeModal
            game={game}
            participants={participants}
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
        <div className="controls">
          <NewGameMenu
            localEpNum={this.state.localEpNum}
            onChangeEpNum={(val) => this.setState({ localEpNum: val })}
            onNewGame={(opts) => this.newGame(opts)}
            onShowCustomModal={() => this.setState({ showCustomModal: true })}
          />
          <button
            type="button"
            className="ui-action-icon ui-action-icon-lg"
            onClick={() => this.setState({ showSettingsModal: true })}
            title="Settings"
          >
            <IconSettings size={20} />
          </button>
          <button
            type="button"
            className="ui-action-icon ui-action-icon-lg"
            onClick={() => this.socket?.emit("JPD:undo")}
            title="Undo Judge"
            disabled={!canJudge}
          >
            <IconArrowBackUp size={20} />
          </button>
          <div className="controlToggle">
            <Switch
              checked={!this.state.readingDisabled}
              onChange={() => {
                const checked = !this.state.readingDisabled;
                this.setState({ readingDisabled: checked });
                if (checked) {
                  window.localStorage.setItem("jeopardy-readingDisabled", "1");
                } else {
                  window.localStorage.removeItem("jeopardy-readingDisabled");
                }
              }}
              label="Reading"
            />
          </div>
          <div className="controlToggle">
            <Switch
              checked={Boolean(game?.enableAIJudge)}
              onChange={(e) => {
                this.socket?.emit("JPD:enableAiJudge", e.target.checked);
              }}
              label="AI Judge"
            />
          </div>
          {/* <div className="controlToggle">
            <Switch
              checked={Boolean(game?.enableAIVoices)}
              onChange={(e) => {
                this.socket?.emit("JPD:enableAiVoices", e.target.checked);
              }}
              label="AI Trebek"
            />
          </div> */}
          {game?.enableAIVoices && game.aiVoiceProgress && (
            <div
              className="controlToggle"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                minWidth: "150px",
              }}
              title={`AI Voices generated: ${game.aiVoiceProgress.count}/${game.aiVoiceProgress.total}`}
            >
              <span style={{ fontSize: "12px", fontWeight: 600 }}>
                Voices: {game.aiVoiceProgress.count}/
                {game.aiVoiceProgress.total}
              </span>
              <div
                className="ui-progress-root"
                style={{ flexGrow: 1, minWidth: "60px" }}
              >
                <div
                  className={`ui-progress-bar ${
                    game.aiVoiceProgress.count < game.aiVoiceProgress.total
                      ? "animated"
                      : ""
                  }`}
                  style={{
                    width: `${
                      game.aiVoiceProgress.total > 0
                        ? (game.aiVoiceProgress.count /
                            game.aiVoiceProgress.total) *
                          100
                        : 0
                    }%`,
                    backgroundColor:
                      game.aiVoiceProgress.total > 0 &&
                      game.aiVoiceProgress.count >= game.aiVoiceProgress.total
                        ? "#2f9e44"
                        : "#228be6",
                  }}
                />
              </div>
            </div>
          )}
          <div className="controlToggle">
            <Switch
              checked={Boolean(isSpectator)}
              onChange={(e) => {
                this.socket?.emit("JPD:spectate", e.target.checked);
              }}
              label="Spectator"
            />
          </div>
          {/* <Button
                  onClick={() => this.socket?.emit('JPD:cmdIntro')}
                  icon
                  labelPosition="left"
                  color="blue"
                >
                  <Icon name="film" />
                  Play Intro
                </Button> */}
          {game && game.airDate && (
            <span
              className="ui-badge ui-badge-md"
              style={{
                height: "36px",
                flexShrink: 0,
                backgroundColor:
                  "#" + getColorHex((game && game.info) || "regular"),
              }}
            >
              {new Date(game.airDate + "T00:00").toLocaleDateString([], {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
              {game && game.info ? " - " + game.info : ""}
            </span>
          )}
        </div>
        <div className="jeopardyMain">
          <div className="boardWrap">
            <div
              id="board"
              className={`board ${this.state.game?.currentQ ? "currentQ" : ""}`}
            >
              {this.state.isIntroPlaying && <div id="intro" />}
              {categories.map((cat, i) => (
                <div key={i} className="category box">
                  {this.state.categoryMask[i] ? cat : ""}
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
                          onClick={clue ? () => this.pickQ(id) : undefined}
                          className={`${clue ? "value" : ""} box`}
                        >
                          {!this.state.clueMask[id] && clue ? clue.value : ""}
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
                        ? "dailyDouble"
                        : ""
                    }`}
                    style={{
                      border: game.canBuzz
                        ? "3px solid #ffffff"
                        : "3px solid rgba(0, 0, 0, 0.7)",
                    }}
                  >
                    <div className="clueHeader">
                      <div className="clueMeta">
                        <div className="category">
                          {game.board[game.currentQ] &&
                            game.board[game.currentQ].category}
                        </div>
                        <div className="category">
                          {Boolean(game.currentValue) && game.currentValue}
                        </div>
                      </div>
                      {(game.canNextQ || (game.currentAnswer && canJudge)) && (
                        <div className="clueTopActions">
                          {game.canNextQ && (
                            <button
                              type="button"
                              className="ui-btn ui-btn-xs"
                              onClick={() => this.socket?.emit("JPD:skipQ")}
                            >
                              <IconPlayerTrackNextFilled />
                              Next
                            </button>
                          )}
                          {game.currentAnswer && canJudge && (
                            <button
                              type="button"
                              className="ui-btn ui-btn-xs"
                              onClick={() =>
                                this.setState({ showJudgingModal: true })
                              }
                            >
                              <IconGavel />
                              Judge
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="clue">
                      {renderQuestion(game.board[game.currentQ].question)}
                    </div>
                    <div className="clueControls">
                      {!game.currentAnswer &&
                      !game.buzzes[clientId] &&
                      !game.submitted[clientId] &&
                      !game.currentDailyDouble &&
                      !isSpectator &&
                      game.round !== "final" ? (
                        <div className="buzzActions">
                          <button
                            type="button"
                            disabled={this.state.buzzFrozen}
                            className={`ui-btn ui-btn-lg buzzBtn ${
                              game.canBuzz ? "ui-btn-green" : "ui-btn-grey"
                            }`}
                            onClick={this.onBuzz}
                          >
                            {game.canBuzz ? <IconBulb /> : <IconLock />}
                            Buzz
                          </button>
                          <button
                            type="button"
                            disabled={this.state.buzzFrozen}
                            className={`ui-btn ui-btn-lg passBtn ${
                              game.canBuzz ? "ui-btn-red" : "ui-btn-grey"
                            }`}
                            onClick={() => {
                              if (game.canBuzz) {
                                this.submitAnswer(null);
                              }
                            }}
                          >
                            {game.canBuzz ? (
                              <IconPlayerTrackNextFilled />
                            ) : (
                              <IconLock />
                            )}
                            Pass
                          </button>
                        </div>
                      ) : null}
                      {!game.currentAnswer &&
                      !game.submitted[clientId] &&
                      game.buzzes[clientId] &&
                      game.questionEndTS ? (
                        <form
                          className="answerInputRow"
                          onSubmit={(e) => {
                            e.preventDefault();
                            this.submitAnswer();
                          }}
                        >
                          <div className="ui-input-group">
                            <input
                              type="text"
                              autoFocus
                              enterKeyHint="send"
                              placeholder="Answer"
                              value={this.state.localAnswer}
                              onChange={(e) => {
                                const val = e.target.value;
                                this.setState({ localAnswer: val });
                                this.socket?.emit(
                                  "JPD:draftAnswer",
                                  this.state.game?.currentQ,
                                  val,
                                );
                              }}
                            />
                            <button
                              type="submit"
                              className="ui-action-icon"
                            >
                              <IconCornerDownRight size={20} />
                            </button>
                          </div>
                        </form>
                      ) : null}
                      {game.waitingForWager &&
                      game.waitingForWager[clientId] ? (
                        <div className="wagerBox">
                          <label className="ui-input-label">
                            {`Wager (${
                              getWagerBounds(game.round, game.scores[clientId])
                                .minWager
                            } - ${
                              getWagerBounds(game.round, game.scores[clientId])
                                .maxWager
                            })`}
                          </label>
                          <form
                            className="ui-input-group"
                            onSubmit={(e) => {
                              e.preventDefault();
                              this.submitWager();
                            }}
                          >
                            <input
                              type="number"
                              enterKeyHint="send"
                              value={this.state.localWager}
                              onChange={(e) => {
                                const val = e.target.value;
                                this.setState({ localWager: val });
                                this.socket?.emit("JPD:draftWager", val);
                              }}
                            />
                            <button
                              type="submit"
                              className="ui-action-icon"
                            >
                              <IconCornerDownRight size={20} />
                            </button>
                          </form>
                          <button
                            type="button"
                            className="ui-btn"
                            onClick={() => {
                              this.submitWager(
                                String(
                                  getWagerBounds(
                                    game.round,
                                    game.scores[clientId],
                                  ).maxWager,
                                ),
                              );
                            }}
                          >
                            {game.currentDailyDouble
                              ? `True Daily Double (max wager)`
                              : "All of it (max wager)"}
                          </button>
                        </div>
                      ) : null}
                      {game.currentAnswer && (
                        <div className="answer">{game.currentAnswer}</div>
                      )}
                    </div>
                    {Boolean(game.playClueEndTS) && (
                      <TimerBar
                        duration={0}
                        text={`Waiting for reading. . . (${((game.playClueEndTS - game.serverTime) / 1000).toFixed(1)} seconds)`}
                      />
                    )}
                    {Boolean(game.questionEndTS) && (
                      <TimerBar
                        duration={game.questionEndTS - game.serverTime}
                        secondary
                        text="Waiting for answers. . ."
                      />
                    )}
                    {Boolean(game.wagerEndTS) && (
                      <TimerBar
                        duration={game.wagerEndTS - game.serverTime}
                        secondary
                        text="Waiting for wagers. . ."
                      />
                    )}
                  </div>
                </div>
              )}
              {game && game.round === "end" && (
                <div id="endgame">
                  <h2 style={{ color: "white" }}>Winner!</h2>
                  <div style={{ display: "flex" }}>
                    {this.getWinners().map((winnerId: string) => (
                      <img
                        key={winnerId}
                        alt=""
                        style={{ width: "80px", height: "80px" }}
                        src={getDefaultPicture(
                          participants.find((p) => p.id === winnerId)?.name ??
                            "",
                          getColorHex(winnerId),
                        )}
                      />
                    ))}
                  </div>
                  <div className="endgameTableWrap">
                    <table className="ui-table ui-table-striped">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Score</th>
                          <th>Qs</th>
                          <th>Answered</th>
                          <th>Correct</th>
                          <th>Incorrect</th>
                          <th>First Buzzes</th>
                          <th>Avg. Reaction</th>
                          <th>Daily Doubles</th>
                        </tr>
                      </thead>
                      <tbody>
                        {participants.map((p) => {
                          return (
                            <tr key={p.id}>
                              <td>{p.name}</td>
                              <td>{this.state.game?.scores[p.id] ?? 0}</td>
                              <td>{this.state.game?.stats?.questions}</td>
                              <td>
                                {this.state.game?.stats?.answered?.[p.id] ?? 0}
                              </td>
                              <td>
                                {this.state.game?.stats?.correct?.[p.id] ?? 0}
                              </td>
                              <td>
                                {this.state.game?.stats?.incorrect?.[p.id] ?? 0}
                              </td>
                              <td>
                                {this.state.game?.stats?.firstBuzz?.[p.id] ?? 0}
                              </td>
                              <td>
                                {`${((this.state.game?.stats?.reactionTimes?.[p.id]?.reduce((a, b) => a + b, 0) ?? 0) / (this.state.game?.stats?.reactionTimes?.[p.id]?.length ?? 0))?.toFixed(0)}ms`}
                              </td>
                              <td>
                                {this.state.game?.stats?.dailyDoubles?.[p.id] ??
                                  0}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div id="scoreboardStrip" className="scoreboardStrip">
            {participants.map((p) => {
              return (
                <div
                  key={p.id}
                  id={`scoreboard-${p.id}`}
                  className="scoreboard"
                >
                  <div className="picture">
                    <img
                      alt=""
                      src={getDefaultPicture(p.name ?? "", getColorHex(p.id))}
                    />
                    <div
                      className="playerNameBar"
                      style={{
                        backgroundColor: "#" + getColorHex(p.id),
                      }}
                    >
                      <div
                        title={p.name || p.id}
                        className="playerNameText"
                      >
                        {p.name || p.id}
                      </div>
                    </div>
                    {game && (
                      <div className="icons">
                        {!game.picker || game.picker === p.id ? (
                          <IconHandFinger title="Controlling the board" />
                        ) : null}
                        {game.host && game.host === p.id ? (
                          <IconStarFilled title="Game host" />
                        ) : null}
                        {!p.connected ? (
                          <IconPlug color="red" title="Disconnected" />
                        ) : null}
                        {p.spectator ? <IconEye title="Spectator" /> : null}
                      </div>
                    )}
                    <JudgeButtons id={p.id} />
                  </div>
                  <div
                    className={`points ${
                      game && game.scores[p.id] < 0 ? "negative" : ""
                    }`}
                  >
                    {(game?.scores[p.id] || 0).toLocaleString()}
                  </div>
                  <div
                    className={`answerBox ${
                      game?.buzzes[p.id] ? "buzz" : ""
                    } ${game?.judges[p.id] === false ? "negative" : ""}`}
                  >
                    {game && game.answers[p.id]}
                    {game && p.id in game.wagers ? (
                      <div
                        style={{
                          position: "absolute",
                          top: "2px",
                          right: "2px",
                        }}
                      >
                        <span
                          title="Wager"
                          className="ui-badge ui-badge-xs"
                          style={{ backgroundColor: "#495057" }}
                        >
                          {game.wagers[p.id] || 0}
                        </span>
                      </div>
                    ) : null}
                    <div className="timeOffset">
                      {this.getBuzzOffset(p.id) && this.getBuzzOffset(p.id) > 0
                        ? `+${(this.getBuzzOffset(p.id) / 1000).toFixed(3)}`
                        : ""}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  }
}

function TimerBar({
  duration,
  secondary,
  text,
}: {
  duration: number;
  secondary?: boolean;
  text?: string;
}) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    requestAnimationFrame(() => {
      setWidth(100);
    });
  }, []);
  return (
    <div
      style={{
        position: "absolute",
        bottom: "0px",
        left: "0px",
        height: "14px",
        width: width + "%",
        backgroundColor: secondary ? "#16AB39" : "#0E6EB8",
        transition: `${duration / 1000}s width linear`,
        fontSize: "12px",
        lineHeight: "10px",
        // textShadow: '1px 1px 2px black',
        textAlign: "left",
        padding: "1px 6px",
        display: "flex",
        overflow: "visible",
        whiteSpace: "nowrap",
        // alignItems: 'center',
      }}
    >
      {text}
    </div>
  );
}

function getWagerBounds(round: string, score: number) {
  // User setting a wager for DD or final
  // Can bet up to current score, minimum of 1000 in single or 2000 in double, 0 in final
  let maxWager = 0;
  let minWager = 5;
  if (round === "jeopardy") {
    maxWager = Math.max(score || 0, 1000);
  } else if (round === "double") {
    maxWager = Math.max(score || 0, 2000);
  } else if (round === "triple") {
    maxWager = Math.max(score || 0, 3000);
  } else if (round === "final") {
    minWager = 0;
    maxWager = Math.max(score || 0, 0);
  }
  return { minWager, maxWager };
}

const SettingsModal = ({
  onClose,
  onSubmit,
  settings,
}: {
  onClose: () => void;
  onSubmit: (settings: GameSettings) => void;
  settings: GameSettings;
}) => {
  const [answerTimeout, setAnswerTimeout] = useState<
    number | string | undefined
  >(settings.answerTimeout || 20);
  const [finalTimeout, setFinalTimeout] = useState<number | string | undefined>(
    settings.finalTimeout || 30,
  );
  const [makeMeHost, setMakeMeHost] = useState<boolean | undefined>(
    settings.makeMeHost,
  );
  const [allowMultipleCorrect, setAllowMultipleCorrect] = useState<
    boolean | undefined
  >(settings.allowMultipleCorrect);
  return (
    <Modal opened onClose={onClose} title="Settings">
      <h4>Settings will be applied to any new games you create.</h4>
      <div style={{ gap: "4px", display: "flex", flexDirection: "column" }}>
        <Switch
          checked={makeMeHost}
          onChange={(e) => setMakeMeHost(e.currentTarget.checked)}
          label="Make me the host (Only the host can select questions and judge answers)"
        />
        <Switch
          checked={allowMultipleCorrect}
          onChange={(e) => setAllowMultipleCorrect(e.currentTarget.checked)}
          label="Allow multiple correct answers. Also disables Daily Doubles and allows any player to pick questions (unless there is a host)"
        />
        <div
          style={{
            display: "flex",
            gap: "10px",
            alignItems: "center",
            fontSize: "14px",
          }}
        >
          <input
            type="number"
            className="ui-number-compact"
            value={answerTimeout}
            onChange={(e) => setAnswerTimeout(e.target.value)}
          />
          Seconds for regular answers and Daily Double wagers (Default: 20)
        </div>
        <div
          style={{
            display: "flex",
            gap: "10px",
            alignItems: "center",
            fontSize: "14px",
          }}
        >
          <input
            type="number"
            className="ui-number-compact"
            value={finalTimeout}
            onChange={(e) => setFinalTimeout(e.target.value)}
          />
          Seconds for Final Jeopardy answers and wagers (Default: 30)
        </div>
      </div>
      <div
        style={{
          display: "flex",
          marginTop: "10px",
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          className="ui-btn"
          onClick={() => {
            const settings: GameSettings = {
              makeMeHost: Boolean(makeMeHost),
              allowMultipleCorrect: Boolean(allowMultipleCorrect),
              answerTimeout: Number(answerTimeout),
              finalTimeout: Number(finalTimeout),
            };
            onSubmit(settings);
            onClose();
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
};

export const ErrorModal = ({ error }: { error: string }) => {
  return (
    <Modal opened onClose={() => {}} title={error} centered>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "8px",
        }}
      >
        <button
          type="button"
          className="ui-btn ui-btn-xl"
          onClick={() => {
            window.location.reload();
          }}
        >
          <IconRefresh />
          Try again
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-xl"
          onClick={() => {
            window.location.href = "/";
          }}
        >
          <IconHome />
          Go to home
        </button>
      </div>
    </Modal>
  );
};

function Modal({
  opened,
  onClose,
  title,
  size,
  centered,
  children,
}: {
  opened?: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  size?: "xl" | string;
  centered?: boolean;
  children: React.ReactNode;
}) {
  if (!opened) return null;
  return (
    <div
      className={`ui-modal-backdrop ${centered ? "centered" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`ui-modal ${size === "xl" ? "xl" : ""}`}>
        <div className="ui-modal-header">
          <h3 className="ui-modal-title">{title}</h3>
          <button
            type="button"
            className="ui-modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>
        <div className="ui-modal-body">{children}</div>
      </div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked?: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
}) {
  return (
    <label className="ui-switch">
      <input type="checkbox" checked={Boolean(checked)} onChange={onChange} />
      <span className="ui-switch-track">
        <span className="ui-switch-thumb" />
      </span>
      <span>{label}</span>
    </label>
  );
}

function NewGameMenu({
  localEpNum,
  onChangeEpNum,
  onNewGame,
  onShowCustomModal,
}: {
  localEpNum: string;
  onChangeEpNum: (val: string) => void;
  onNewGame: (options: { number?: string; filter?: string }) => void;
  onShowCustomModal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="ui-menu" ref={menuRef}>
      <button
        type="button"
        className="ui-btn ui-btn-sm"
        style={{ flexShrink: 0 }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - 248));
          setPos({ top: rect.bottom + 4, left });
          setOpen((v) => !v);
        }}
      >
        <IconStarFilled size={20} />
        New Game
      </button>
      {open && (
        <div
          className="ui-menu-dropdown"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="ui-menu-label">Game #</div>
          <div style={{ padding: "0 8px 8px" }}>
            <form
              className="ui-input-group"
              onSubmit={(e) => {
                e.preventDefault();
                onNewGame({ number: localEpNum });
                setOpen(false);
              }}
            >
              <input
                type="text"
                enterKeyHint="go"
                value={localEpNum}
                onChange={(e) => onChangeEpNum(e.target.value)}
              />
              <button
                type="submit"
                className="ui-action-icon"
              >
                <IconCornerDownRight name="arrow right" />
              </button>
            </form>
          </div>
          <hr className="ui-menu-divider" />
          <div className="ui-menu-label">Random</div>
          {[
            { key: "all", value: null, text: "Any" },
            { key: "kids", value: "kids", text: "Kids Week" },
            { key: "teen", value: "teen", text: "Teen Tournament" },
            {
              key: "college",
              value: "college",
              text: "College Championship",
            },
            {
              key: "celebrity",
              value: "celebrity",
              text: "Celebrity Jeopardy",
            },
            {
              key: "teacher",
              value: "teacher",
              text: "Teachers Tournament",
            },
            {
              key: "champions",
              value: "champions",
              text: "Tournament of Champions",
            },
          ].map((item) => (
            <button
              type="button"
              className="ui-menu-item"
              key={item.key}
              onClick={() => {
                onNewGame({ filter: item.value ?? undefined });
                setOpen(false);
              }}
            >
              {item.text}
            </button>
          ))}
          <hr className="ui-menu-divider" />
          <div className="ui-menu-label">Custom</div>
          <button
            type="button"
            className="ui-menu-item"
            onClick={() => {
              onShowCustomModal();
              setOpen(false);
            }}
          >
            Upload
          </button>
        </div>
      )}
    </div>
  );
}

const renderQuestion = (input: string | undefined): React.ReactNode | null => {
  if (!input) {
    return null;
  }
  // If a valid image string, return an image
  let regex =
    /^https?:\/\/.*\/.*\.(png|gif|webp|jpeg|jpg|heic|heif|jfif)\??.*$/gim;
  if (input?.match(regex)) {
    return (
      <img
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
        src={input}
      />
    );
  }
  return input;
};
