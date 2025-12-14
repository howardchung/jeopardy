export const getPerQuestionState = () => {
  return {
    currentQ: "",
    currentAnswer: undefined as string | undefined,
    currentValue: 0,
    playClueEndTS: 0,
    questionEndTS: 0,
    wagerEndTS: 0,
    buzzUnlockTS: 0,
    currentDailyDouble: false,
    canBuzz: false,
    canNextQ: false,
    toJudge: [] as string[][],
    currentJudgeAnswer: undefined as string | undefined,
    currentJudgeAnswerIndex: undefined as number | undefined,
    dailyDoublePlayer: undefined as string | undefined,
    answers: {} as Record<string, string>,
    submitted: {} as Record<string, boolean>,
    judges: {} as Record<string, boolean | null>,
    buzzes: {} as Record<string, number>,
    wagers: {} as Record<string, number>,
    // We track this separately from wagers because the list of people to wait for is different depending on context
    // e.g. for Double we only need to wait for 1 player, for final we have to wait for everyone
    waitingForWager: undefined as Record<string, boolean> | undefined,
  };
};

export const getGameState = (
  options: {
    epNum?: string;
    airDate?: string;
    info?: string;
    answerTimeout?: number;
    finalTimeout?: number;
    allowMultipleCorrect?: boolean;
    host?: string;
    enableAIJudge?: boolean;
  },
  jeopardy?: RawQuestion[],
  double?: RawQuestion[],
  triple?: RawQuestion[],
  final?: RawQuestion[],
) => {
  return {
    jeopardy,
    double,
    triple,
    final,
    answers: {} as Record<string, string>,
    wagers: {} as Record<string, number>,
    board: {} as { [key: string]: RawQuestion },
    public: {
      serverTime: Date.now(),
      epNum: options.epNum,
      airDate: options.airDate,
      info: options.info,
      board: {} as { [key: string]: Question },
      scores: {} as Record<string, number>, // player scores
      round: "start" as RoundName,
      picker: undefined as string | undefined, // If null let anyone pick, otherwise last correct answer
      // below is populated in emitstate from settings
      host: undefined as string | undefined,
      enableAIJudge: false,
      enableAIVoices: undefined as string | undefined,
      ...getPerQuestionState(),
    },
  };
};
export type PublicGameState = ReturnType<typeof getGameState>["public"];
