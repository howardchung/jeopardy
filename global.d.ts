type StringDict = { [key: string]: string };
type NumberDict = { [key: string]: number };
type BooleanDict = { [key: string]: boolean | null };

interface User {
  id: string;
  isVideoChat?: boolean;
  isScreenShare?: boolean;
  isController?: boolean;
}

interface ChatMessage {
  timestamp: string;
  videoTS?: number;
  id: string;
  cmd: string;
  msg: string;
}

type GameOptions = {
  number?: string,
  filter?: string,
  makeMeHost?: boolean,
  allowMultipleCorrect?: boolean,
  // timeout to use for DD wagers and question answers
  answerTimeout?: number,
  // timeout to use for final wagers and answers (all players participate)
  finalTimeout?: number,
};
