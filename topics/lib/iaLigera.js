import { llamarClaudeDirecto } from "./anthropic.js";

const SMALL_MODEL = "claude-haiku-4-5";
const STANDARD_MODEL = "claude-sonnet-5-5";

export function modelForTask(requested) {
  return /3b|haiku/i.test(String(requested || "")) ? SMALL_MODEL : STANDARD_MODEL;
}

export async function llamarIA({ system, prompt, model, maxTokens = 8000, parseJson = false }) {
  return llamarClaudeDirecto({ system, prompt, model: modelForTask(model), maxTokens, parseJson });
}
