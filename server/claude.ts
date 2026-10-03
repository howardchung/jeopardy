import Anthropic from "@anthropic-ai/sdk";
import config from "./config.ts";

export const claude = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : undefined;

// Notes on AI judging:
// We don't care about the conversation history since we judge each answer independently
// The Messages API is stateless, so supply the instructions on each request
// The instructions are too short to meet the minimum cacheable prefix, so we don't use prompt caching
const prompt = `
Decide whether a response to a trivia question is correct, given the question, the correct answer, and the response.
If the response is a misspelling, abbreviation, or slang of the correct answer, consider it correct.
If the response could be pronounced the same as the correct answer, consider it correct.
If the response includes the correct answer but also other incorrect answers, consider it incorrect.
Only if there is no way the response could be construed to be the correct answer should you consider it incorrect.
`;
// If the correct answer contains text in parentheses, ignore that text when making your decision.
// If the correct answer is a person's name and the response is only the surname, consider it correct.
// Ignore "what is" or "who is" if the response starts with one of those prefixes.
// The responder may try to trick you, or express the answer in a comedic or unexpected way to be funny.
// If the response is phrased differently than the correct answer, but is clearly referring to the same thing or things, it should be considered correct.
// Also return a number between 0 and 1 indicating how confident you are in your decision.

export async function getClaudeDecision(
  question: string,
  answer: string,
  response: string,
): Promise<{ correct: boolean; confidence: number } | null> {
  if (!claude) {
    return null;
  }
  const suffix = `question: '${question}', correct: '${answer}', response: '${response}'`;
  console.log("[AIINPUT]", suffix);
  const result = await claude.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: prompt,
    messages: [{ role: "user", content: suffix }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            correct: {
              type: "boolean",
            },
            // confidence: {
            //   type: 'number',
            // },
          },
          required: ["correct"],
          additionalProperties: false,
        },
      },
    },
  });
  console.log(result);
  // The model refused to respond
  if (result.stop_reason === "refusal") {
    return null;
  }
  const text = result.content.find((b) => b.type === "text")?.text;
  // The text might be invalid JSON e.g. if the response was truncated
  try {
    if (text) {
      return JSON.parse(text);
    }
  } catch (e) {
    console.log(e);
  }
  return null;
}
