interface User {
  id: string;
  name?: string;
  connected: boolean;
  disconnectTime: number;
}

interface ChatMessage {
  timestamp: string;
  videoTS?: number;
  id: string;
  cmd: string;
  msg: string;
}

type GameOptions = {
  number?: string;
  filter?: string;
  makeMeHost?: boolean;
  allowMultipleCorrect?: boolean;
  enableAIJudge?: boolean;
  // timeout to use for DD wagers and question answers
  answerTimeout?: number;
  // timeout to use for final wagers and answers (all players participate)
  finalTimeout?: number;
};
