import "./App.css";
import React, { useCallback, useEffect, useState } from "react";
import { serverPath, generateName } from "../../utils";
import { Chat } from "../Chat/Chat";
import { JeopardyTopBar } from "../TopBar/TopBar";
import { Jeopardy } from "../Jeopardy/Jeopardy";
import { type Socket } from "socket.io-client";

export function App() {
  const [participants, setParticipants] = useState<User[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [myName, setMyName] = useState("");
  const [scrollTimestamp, setScrollTimestamp] = useState(0);
  const [socket, setSocket] = useState<Socket | undefined>(undefined);

  useEffect(() => {
    const heartbeat = window.setInterval(
      () => {
        fetch(serverPath + "/ping");
      },
      10 * 60 * 1000,
    );
    return () => {
      window.clearInterval(heartbeat);
    };
  }, []);

  const updateName = useCallback(
    (name: string) => {
      if (socket) {
        setMyName(name);
        socket.emit("CMD:name", name);
        window.localStorage.setItem("watchparty-username", name);
      }
    },
    [socket],
  );

  return (
    <React.Fragment>
      <JeopardyTopBar />
      <div className="app-grid">
        <div className="fullHeightColumn">
          <Jeopardy
            participants={participants}
            chat={chat}
            updateName={updateName}
            setParticipants={setParticipants}
            setSocket={setSocket}
            setScrollTimestamp={setScrollTimestamp}
            setChat={setChat}
          />
        </div>
        <div className="chatColumn">
          <form
            className="ui-input-group"
            onSubmit={(e) => {
              e.preventDefault();
              (document.activeElement as HTMLElement | null)?.blur?.();
            }}
          >
            <span className="ui-input-section">Name:</span>
            <input
              type="text"
              enterKeyHint="done"
              value={myName}
              onChange={(e) => updateName(e.target.value)}
            />
            <button
              type="button"
              className="ui-btn ui-btn-compact-xs"
              onClick={async () => updateName(await generateName())}
            >
              Random
            </button>
          </form>
          <Chat
            chat={chat}
            scrollTimestamp={scrollTimestamp}
            socket={socket}
          />
        </div>
      </div>
    </React.Fragment>
  );
}
