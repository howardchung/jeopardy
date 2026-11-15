import React, { useCallback } from "react";
import { serverPath } from "../../utils";
import "../Jeopardy/Jeopardy.css";
import { IconBrandGithub, IconCirclePlusFilled } from "../Icons";
import "./TopBar.css";

export function NewRoomButton({ size }: { size?: string }) {
  const createRoom = useCallback(async () => {
    const response = await fetch(serverPath + "/createRoom", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    const { name } = data;
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.set("game", name);
    window.location.search = searchParams.toString();
  }, []);
  return (
    <button
      type="button"
      className={`ui-btn ${size ? `ui-btn-${size}` : ""}`}
      onClick={createRoom}
    >
      <IconCirclePlusFilled />
      New Room
    </button>
  );
}

export function JeopardyTopBar({ hideNewRoom }: { hideNewRoom?: boolean }) {
  return (
    <header className="topBar">
      <a href="/" className="topBarBrand">
        <div className="logoCircle">J!</div>
        <div className="logoText">Jeopardy!</div>
      </a>
      <div className="topBarActions">
        {!hideNewRoom && <NewRoomButton />}
        <a
          href="https://github.com/howardchung/jeopardy"
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub"
          className="ui-action-icon ui-action-icon-36 ui-action-icon-gray"
        >
          <IconBrandGithub />
        </a>
      </div>
    </header>
  );
}
