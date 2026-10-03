/**
 * Help panel UI (docs/help-assistant.md): the Help entry opens a dialog with searchable
 * articles, an "Ask a question" chat that shows cited articles, and "Contact support".
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-2222-2222-222222222222";

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ organizationId: ORG, companyId: null, setOrganizationId: vi.fn(), setCompanyId: vi.fn() }),
}));

import { HelpButton } from "@/components/help/HelpPanel";
import { HELP_ARTICLES } from "@/content/help/articles";

const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function openPanel() {
  render(<HelpButton />);
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  return screen.getByRole("dialog");
}

function goToAsk(dialog: HTMLElement) {
  fireEvent.mouseDown(within(dialog).getByRole("tab", { name: "Ask a question" }));
}

describe("HelpPanel", () => {
  it("opens from the Help button and lists every article", () => {
    const dialog = openPanel();
    expect(within(dialog).getByRole("heading", { name: "Help" })).toBeInTheDocument();
    const list = within(dialog).getByRole("list", { name: "Help articles" });
    expect(within(list).getAllByRole("button")).toHaveLength(HELP_ARTICLES.length);
  });

  it("searches articles and opens one", () => {
    const dialog = openPanel();
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search help articles" }), {
      target: { value: "turn off forwarding rogers" },
    });
    const list = within(dialog).getByRole("list", { name: "Help articles" });
    const first = within(list).getAllByRole("button")[0];
    expect(first).toHaveTextContent("Turn call forwarding on and off");

    fireEvent.click(first);
    expect(within(dialog).getByRole("heading", { name: "Turn call forwarding on and off" })).toBeInTheDocument();
    expect(within(dialog).getByText("##004#")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /All articles/ }));
    expect(within(dialog).getByRole("list", { name: "Help articles" })).toBeInTheDocument();
  });

  it("offers to ask when nothing matches", () => {
    const dialog = openPanel();
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search help articles" }), {
      target: { value: "zzzqqq" },
    });
    expect(within(dialog).getByText(/No articles match/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Ask/ }));
    expect(within(dialog).getByLabelText("Your question")).toHaveValue("zzzqqq");
  });

  it("asks a question and shows the answer with its cited article", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: { status: "answered", answer: "Dial ##004# to turn it off.", sources: [{ id: "call-forwarding", title: "Turn call forwarding on and off" }] } }),
    );
    const dialog = openPanel();
    goToAsk(dialog);
    fireEvent.change(within(dialog).getByLabelText("Your question"), { target: { value: "how do I stop forwarding?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send question" }));

    expect(await within(dialog).findByText("Dial ##004# to turn it off.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`/api/organizations/${ORG}/help/ask`);
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toMatchObject({ question: "how do I stop forwarding?", history: [] });
    expect(sent.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    fireEvent.click(within(dialog).getByRole("button", { name: /Turn call forwarding on and off/ }));
    expect(within(dialog).getByRole("heading", { name: "Turn call forwarding on and off" })).toBeInTheDocument();
  });

  it("escalates to support when the assistant isn't sure", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: { status: "not_sure", answer: "I'm not sure.", sources: [] } }))
      .mockResolvedValueOnce(json({ data: { id: "req-1", message: "We've got it — we'll reply by email." } }));
    const dialog = openPanel();
    goToAsk(dialog);
    fireEvent.change(within(dialog).getByLabelText("Your question"), { target: { value: "can you port my number?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send question" }));
    await within(dialog).findByText("I'm not sure.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Contact support" }));
    const form = within(dialog).getByRole("form", { name: "Contact support" });
    expect(within(form).getByRole("textbox")).toHaveValue("can you port my number?");
    fireEvent.click(within(form).getByRole("button", { name: /Send to support/ }));

    expect(await within(dialog).findByText(/We've got it — we'll reply by email\./)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe(`/api/organizations/${ORG}/help/escalate`);
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      question: "can you port my number?",
      reason: "not_sure",
      transcript: [
        { role: "user", text: "can you port my number?" },
        { role: "assistant", text: "I'm not sure." },
      ],
    });
  });

  it("shows a friendly message when rate-limited", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "Too many requests." }, 429));
    const dialog = openPanel();
    goToAsk(dialog);
    fireEvent.change(within(dialog).getByLabelText("Your question"), { target: { value: "billing?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/reached the Help limit/));
  });
});
