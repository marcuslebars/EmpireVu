import { z } from "zod";

import { findHelpArticle } from "@/content/help/articles";
import { getHelpIndex, retrieveHelpSections, type ScoredSection } from "@/content/help/search";
import type { HelpModelAnswer } from "@/server/ai/help-assistant";
import type { AiUsageMeta } from "@/server/ai/claude";
import { describeAccount, type HelpAccountContext } from "@/server/services/help/account-context";

/**
 * Help assistant orchestration (docs/help-assistant.md): retrieve → (maybe) ask the model →
 * post-check. Pure apart from the injected model call, so the prompt assembly and the
 * guard rails are unit-tested without a network.
 */

export const MAX_QUESTION_CHARS = 1000;
export const MAX_TURN_CHARS = 2000;
export const MAX_HISTORY_TURNS = 6;

export const chatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(MAX_TURN_CHARS * 2),
});
export type ChatTurn = z.infer<typeof chatTurnSchema>;

export type HelpAnswerStatus = "answered" | "not_sure" | "handoff_requested";

export interface HelpAnswer {
  status: HelpAnswerStatus;
  answer: string;
  sources: Array<{ id: string; title: string }>;
}

export const NOT_COVERED_ANSWER =
  "I'm not sure — I couldn't find that in the help articles. Click Contact support and a person will reply by email.";
export const HANDOFF_ANSWER =
  "Sure — click Contact support below and the EmpireVu team will reply by email.";
export const PRICE_GUARD_ANSWER =
  "For prices, see your plan in Settings → Billing & Plans. If you have a billing question, click Contact support.";

/** "Can I talk to a person?" — answered without a model call. */
export function wantsHuman(question: string): boolean {
  return /\b(talk|speak|chat)\s+(to|with)\s+(a\s+|an\s+|someone|somebody|a real|real)?\s*(human|person|someone|somebody|agent|rep|representative|support|people)\b|\b(real|actual|live)\s+(person|human|agent)\b|\bhuman\s+(please|support|help)\b|\bcontact\s+support\b|\bcustomer\s+service\b/i.test(
    question,
  );
}

/**
 * User-typed (and user-controlled, like an org name) text goes into the prompt inside tags.
 * Escape angle brackets so it can't close its own tag and pose as article content or rules.
 */
export function neutralize(text: string, maxChars: number): string {
  return text.slice(0, maxChars).replace(/</g, "‹").replace(/>/g, "›").trim();
}

/** Keep the last few turns, trimmed — they're context, not instructions. */
export function trimHistory(history: readonly ChatTurn[]): ChatTurn[] {
  return history
    .filter((turn) => turn.text.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({ role: turn.role, text: turn.text.slice(0, MAX_TURN_CHARS) }));
}

/**
 * Assemble the single user message the model sees. Order matters for prompt hygiene: the
 * trusted material (articles, account) first, the user's own words last and clearly fenced.
 * The articles come from the shipped library only; the account block is the caller's own org.
 */
export function buildHelpUserMessage(input: {
  question: string;
  history: readonly ChatTurn[];
  sections: readonly ScoredSection[];
  account: HelpAccountContext;
}): string {
  const byArticle = new Map<string, ScoredSection[]>();
  for (const hit of input.sections) {
    const list = byArticle.get(hit.article.id) ?? [];
    list.push(hit);
    byArticle.set(hit.article.id, list);
  }

  const articleBlocks = [...byArticle.entries()].map(([id, hits]) => {
    const article = hits[0].article;
    const sections = [...hits]
      .sort((a, b) => a.sectionIndex - b.sectionIndex)
      .map((hit) => `### ${hit.section.heading}\n${hit.section.body}`)
      .join("\n\n");
    return `<article id="${id}" title="${article.title}">\n${sections}\n</article>`;
  });

  const accountLines = describeAccount(input.account).map((line) => neutralize(line, 300));
  const history = trimHistory(input.history);

  const parts = [
    "<help_articles>",
    articleBlocks.join("\n\n"),
    "</help_articles>",
    "",
    "<account>",
    accountLines.length ? accountLines.join("\n") : "(no account details available)",
    "</account>",
  ];

  if (history.length > 0) {
    parts.push(
      "",
      "<conversation_so_far>",
      ...history.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${neutralize(turn.text, MAX_TURN_CHARS)}`),
      "</conversation_so_far>",
    );
  }

  parts.push("", "<user_question>", neutralize(input.question, MAX_QUESTION_CHARS), "</user_question>");
  return parts.join("\n");
}

/** Retrieval query: the question plus the user's previous turn, so "how do I turn it off?" still finds its topic. */
export function retrievalQuery(question: string, history: readonly ChatTurn[]): string {
  const lastUser = [...history].reverse().find((turn) => turn.role === "user");
  return lastUser ? `${question} ${lastUser.text.slice(0, 300)}` : question;
}

/** Validate what the model said against what it was given. */
export function finalizeModelAnswer(model: HelpModelAnswer, sections: readonly ScoredSection[]): HelpAnswer {
  // Never show a price: they live in Stripe, and the model was told not to — enforce it.
  if (/\$\s?\d/.test(model.answer)) {
    return { status: "not_sure", answer: PRICE_GUARD_ANSWER, sources: [] };
  }

  const provided = new Set(sections.map((s) => s.article.id));
  const sources: HelpAnswer["sources"] = [];
  for (const id of model.sourceArticleIds) {
    const article = provided.has(id) ? findHelpArticle(id) : undefined;
    if (article && !sources.some((s) => s.id === id)) sources.push({ id, title: article.title });
  }

  if (model.status === "not_sure") {
    return { status: "not_sure", answer: model.answer.trim(), sources: [] };
  }
  return { status: "answered", answer: model.answer.trim(), sources };
}

export interface AskHelpDeps {
  /** null when AI isn't configured — the panel then points at the matching articles instead. */
  callModel: ((userMessage: string) => Promise<{ answer: HelpModelAnswer; usage: AiUsageMeta }>) | null;
  recordUsage: (usage: AiUsageMeta) => Promise<void>;
}

export interface AskHelpResult extends HelpAnswer {
  /** Article ids retrieved (for the deflection log), whether or not the model cited them. */
  retrieved: string[];
  modelCalled: boolean;
  /** The model call failed (or AI is off) and the answer is the article-list fallback. */
  fallback: "ai_unavailable" | "ai_error" | null;
}

export const FALLBACK_ANSWER =
  "I can't write an answer right now, but these help articles look like a match. If they don't cover it, click Contact support.";

function articleFallback(sections: readonly ScoredSection[]): HelpAnswer {
  const sources: HelpAnswer["sources"] = [];
  for (const hit of sections) {
    if (sources.length >= 3) break;
    if (!sources.some((s) => s.id === hit.article.id)) sources.push({ id: hit.article.id, title: hit.article.title });
  }
  return { status: "not_sure", answer: FALLBACK_ANSWER, sources };
}

export async function askHelp(
  input: { question: string; history: readonly ChatTurn[]; account: HelpAccountContext },
  deps: AskHelpDeps,
): Promise<AskHelpResult> {
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARS);

  if (wantsHuman(question)) {
    return { status: "handoff_requested", answer: HANDOFF_ANSWER, sources: [], retrieved: [], modelCalled: false, fallback: null };
  }

  const sections = retrieveHelpSections(getHelpIndex(), retrievalQuery(question, input.history));
  const retrieved = [...new Set(sections.map((s) => s.article.id))];

  // Nothing in the library matches: don't spend a model call to say so.
  if (sections.length === 0) {
    return { status: "not_sure", answer: NOT_COVERED_ANSWER, sources: [], retrieved, modelCalled: false, fallback: null };
  }

  if (!deps.callModel) {
    return { ...articleFallback(sections), retrieved, modelCalled: false, fallback: "ai_unavailable" };
  }

  const userMessage = buildHelpUserMessage({ question, history: input.history, sections, account: input.account });
  let modelResult: { answer: HelpModelAnswer; usage: AiUsageMeta };
  try {
    modelResult = await deps.callModel(userMessage);
  } catch (err) {
    console.error("[help] model call failed:", err instanceof Error ? err.message : err);
    return { ...articleFallback(sections), retrieved, modelCalled: true, fallback: "ai_error" };
  }
  await deps.recordUsage(modelResult.usage);

  return { ...finalizeModelAnswer(modelResult.answer, sections), retrieved, modelCalled: true, fallback: null };
}
