/**
 * Reading JSON back out of a model response.
 *
 * Drafting broke in production with "The AI response was not valid JSON": the answer was
 * constrained only by the prompt, so reasoning written alongside it defeated `JSON.parse`.
 * The format is now pinned by `output_config.format`; these cover the backstop and the
 * failure messages, which have to say which failure it was.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { extractJsonObject, parseModelJson } from "@/server/ai/claude";

function messageWith(text: string, stopReason: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "msg_1",
    content: text ? [{ citations: null, text, type: "text" }] : [],
    model: "claude-opus-4-8",
    role: "assistant",
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Anthropic.Message;
}

describe("extractJsonObject", () => {
  it("reads a bare object", () => {
    expect(extractJsonObject('{"summary":"ok"}')).toEqual({ summary: "ok" });
  });

  it("reads a fenced object", () => {
    expect(extractJsonObject('```json\n{"summary":"ok"}\n```')).toEqual({ summary: "ok" });
  });

  it("reads an object the model wrote around", () => {
    const raw = 'Looking at the calendar, Tuesday is free.\n\n{"summary":"ok"}\n\nHappy to adjust.';
    expect(extractJsonObject(raw)).toEqual({ summary: "ok" });
  });

  it("throws when there is no object at all", () => {
    expect(() => extractJsonObject("sorry, I can't help with that")).toThrow(/not valid JSON/);
  });
});

describe("parseModelJson", () => {
  it("names truncation rather than blaming the JSON", () => {
    expect(() => parseModelJson(messageWith('{"summary":"ok', "max_tokens"), "lead analysis")).toThrow(
      /cut off/,
    );
  });

  it("names a refusal", () => {
    expect(() => parseModelJson(messageWith("", "refusal"), "lead analysis")).toThrow(/declined/);
  });

  it("names an empty response", () => {
    expect(() => parseModelJson(messageWith(""), "lead analysis")).toThrow(/no lead analysis/);
  });

  it("logs the prefix for diagnosis without putting it in the thrown error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prose = "I can't produce that safely — here is why: the lead's phone number is missing.";

    expect(() => parseModelJson(messageWith(prose), "lead analysis")).toThrow(/not valid JSON/);
    expect(() => parseModelJson(messageWith(prose), "lead analysis")).not.toThrow(/phone number/);
    expect(warn).toHaveBeenCalledWith(
      "[ai] lead analysis: could not parse response",
      expect.objectContaining({ prefix: expect.stringContaining("I can't produce that") }),
    );

    warn.mockRestore();
  });
});
