interface User {
  id: string;
  name?: string;
  connected: boolean;
  disconnectTime: number;
  spectator: boolean;
}

interface ChatMessage {
  timestamp: string;
  videoTS?: number;
  id: string;
  cmd: string;
  msg: string;
  bot?: boolean;
}

interface RawQuestion {
  val: number;
  cat: string;
  x?: number;
  y?: number;
  q?: string;
  a?: string;
  dd?: boolean;
}

interface Question {
  value: number;
  category: string;
  question?: string;
  answer?: string;
  daily_double?: boolean;
}

type GameOptions = {
  number?: string;
  filter?: string;
  makeMeHost?: boolean;
  allowMultipleCorrect?: boolean;
  // Turns on AI judge by default (otherwise needs to be enabled per game)
  enableAIJudge?: boolean;
  // timeout to use for DD wagers and question answers
  answerTimeout?: number;
  // timeout to use for final wagers and answers (all players participate)
  finalTimeout?: number;
};

type RoundName = 'start' | 'jeopardy' | 'double' | 'triple' | 'final' | 'end';