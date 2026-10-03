import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, CheckCircle2, HelpCircle, LifeBuoy, Loader2, MessageCircleQuestion, Search, Send } from "lucide-react";

import { HELP_ARTICLES, findHelpArticle } from "@/content/help/articles";
import { getHelpIndex, searchHelpArticles } from "@/content/help/search";
import type { HelpArticle } from "@/content/help/types";
import { HelpArticleBody } from "@/components/help/HelpArticleBody";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api-client";
import {
  askHelpQuestion,
  contactSupport,
  newHelpSessionId,
  type HelpAnswerStatus,
  type HelpChatTurn,
} from "@/lib/help-api";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";

/**
 * The in-app Help panel (docs/help-assistant.md): searchable help articles plus an
 * "Ask a question" chat grounded in those articles, with "Contact support" escalation.
 * Mounted from the app top bar and the setup wizard, so it's on every signed-in screen.
 */

interface ChatMessage extends HelpChatTurn {
  status?: HelpAnswerStatus;
  sources?: Array<{ id: string; title: string }>;
}

type Tab = "articles" | "ask";

const primaryBtn =
  "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50";
const secondaryBtn =
  "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50";

function friendlyError(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return "You've reached the Help limit for now. Try again later, or contact support.";
  }
  return "Something went wrong getting an answer. Try again, or contact support.";
}

// ── Articles tab ──────────────────────────────────────────────────────────────

function ArticleView({ article, onBack }: { article: HelpArticle; onBack: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), [article.id]);
  return (
    <article className="space-y-4" aria-labelledby={`help-article-${article.id}`}>
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> All articles
      </button>
      <h3 id={`help-article-${article.id}`} ref={headingRef} tabIndex={-1} className="text-base font-semibold text-foreground outline-none">
        {article.title}
      </h3>
      {article.sections.map((section) => (
        <section key={section.heading} className="space-y-1.5">
          <h4 className="text-sm font-semibold text-foreground">{section.heading}</h4>
          <HelpArticleBody body={section.body} />
        </section>
      ))}
    </article>
  );
}

function ArticlesTab({
  openArticleId,
  setOpenArticleId,
  onAsk,
}: {
  openArticleId: string | null;
  setOpenArticleId: (id: string | null) => void;
  onAsk: (question: string) => void;
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const q = query.trim();
    return q ? searchHelpArticles(getHelpIndex(), q).map((r) => r.article) : [...HELP_ARTICLES];
  }, [query]);

  const open = openArticleId ? findHelpArticle(openArticleId) : undefined;
  if (open) return <ArticleView article={open} onBack={() => setOpenArticleId(null)} />;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help (e.g. call forwarding)"
          aria-label="Search help articles"
          className="w-full pl-9 pr-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
      <p className="sr-only" aria-live="polite">
        {query.trim() ? `${results.length} article${results.length === 1 ? "" : "s"} found` : ""}
      </p>
      {results.length === 0 ? (
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground space-y-3">
          <p>No articles match that. Try other words, or ask the assistant.</p>
          <button type="button" className={secondaryBtn} onClick={() => onAsk(query.trim())}>
            <MessageCircleQuestion className="w-4 h-4" aria-hidden="true" /> Ask “{query.trim().slice(0, 40)}”
          </button>
        </div>
      ) : (
        <ul className="space-y-1.5" aria-label="Help articles">
          {results.map((article) => (
            <li key={article.id}>
              <button
                type="button"
                onClick={() => setOpenArticleId(article.id)}
                className="w-full text-left rounded-lg border border-border px-3 py-2.5 hover:bg-secondary/60 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
              >
                <span className="block text-sm font-medium text-foreground">{article.title}</span>
                <span className="block text-xs text-muted-foreground mt-0.5">{article.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Ask tab ───────────────────────────────────────────────────────────────────

function SupportForm({
  orgId,
  sessionId,
  messages,
  onCancel,
}: {
  orgId: string;
  sessionId: string;
  messages: ChatMessage[];
  onCancel: () => void;
}) {
  const lastQuestion = [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
  const lastAnswer = [...messages].reverse().find((m) => m.role === "assistant");
  const [question, setQuestion] = useState(lastQuestion);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setState("sending");
    setError(null);
    try {
      await contactSupport(orgId, {
        question: question.trim(),
        transcript: messages.map(({ role, text }) => ({ role, text })),
        sessionId,
        reason: lastAnswer?.status === "not_sure" ? "not_sure" : "user_requested",
      });
      setState("sent");
    } catch (err) {
      setState("error");
      setError(
        err instanceof ApiError && err.status === 429
          ? "You've sent several requests today already — we'll get back to you on those first."
          : "That didn't go through. Please try again.",
      );
    }
  };

  if (state === "sent") {
    return (
      <div role="status" className="rounded-lg border border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/10 p-4 space-y-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CheckCircle2 className="w-4 h-4 text-[hsl(var(--success))]" aria-hidden="true" /> We've got it — we'll reply by email.
        </p>
        <button type="button" className="text-xs font-medium text-muted-foreground hover:text-foreground" onClick={onCancel}>
          Back to Help
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="rounded-lg border border-border p-3 space-y-2" aria-label="Contact support">
      <label htmlFor="help-support-question" className="block text-sm font-semibold text-foreground">
        Contact support
      </label>
      <p className="text-xs text-muted-foreground">
        A person on the EmpireVu team will read this and reply by email. We include this conversation so you don't have to repeat yourself.
      </p>
      <textarea
        id="help-support-question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="What do you need help with?"
        className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primaryBtn} disabled={state === "sending" || !question.trim()}>
          {state === "sending" ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <LifeBuoy className="w-4 h-4" aria-hidden="true" />}
          Send to support
        </button>
        <button type="button" className={secondaryBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AskTab({
  orgId,
  sessionId,
  draft,
  setDraft,
  messages,
  setMessages,
  onOpenArticle,
}: {
  orgId: string;
  sessionId: string;
  draft: string;
  setDraft: (value: string) => void;
  messages: ChatMessage[];
  setMessages: (update: (prev: ChatMessage[]) => ChatMessage[]) => void;
  onOpenArticle: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages, pending, supportOpen]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const question = draft.trim();
    if (!question || pending) return;
    const history = messages.map(({ role, text }) => ({ role, text }));
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setDraft("");
    setPending(true);
    setError(null);
    try {
      const res = await askHelpQuestion(orgId, { question, history, sessionId });
      setMessages((prev) => [...prev, { role: "assistant", text: res.answer, status: res.status, sources: res.sources }]);
      if (res.status === "handoff_requested") setSupportOpen(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div role="log" aria-live="polite" aria-label="Help conversation" className="space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask about setup, your phone number, call forwarding, your website form, quotes, billing and more. Answers come from the EmpireVu help articles.
          </p>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-8 rounded-lg bg-primary/10 px-3 py-2 text-sm text-foreground whitespace-pre-wrap break-words">
              <span className="sr-only">You: </span>
              {m.text}
            </div>
          ) : (
            <div key={i} className="mr-4 rounded-lg border border-border px-3 py-2 space-y-2">
              <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                <span className="sr-only">Help assistant: </span>
                {m.text}
              </p>
              {m.sources && m.sources.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">From:</span>
                  {m.sources.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => onOpenArticle(s.id)}
                      className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-secondary/70"
                    >
                      <BookOpen className="w-3 h-3" aria-hidden="true" /> {s.title}
                    </button>
                  ))}
                </div>
              )}
              {(m.status === "not_sure" || m.status === "handoff_requested") && !supportOpen && (
                <button type="button" className={secondaryBtn} onClick={() => setSupportOpen(true)}>
                  <LifeBuoy className="w-4 h-4" aria-hidden="true" /> Contact support
                </button>
              )}
            </div>
          ),
        )}
        {pending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Looking that up…
          </p>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>

      {supportOpen ? (
        <SupportForm orgId={orgId} sessionId={sessionId} messages={messages} onCancel={() => setSupportOpen(false)} />
      ) : (
        <form onSubmit={(e) => void send(e)} className="space-y-2">
          <label htmlFor="help-question" className="sr-only">
            Your question
          </label>
          <div className="flex items-end gap-2">
            <textarea
              id="help-question"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
              maxLength={1000}
              placeholder="Type your question…"
              className="flex-1 min-w-0 px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
            />
            <button type="submit" className={primaryBtn} disabled={pending || !draft.trim()} aria-label="Send question">
              <Send className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <button type="button" onClick={() => setSupportOpen(true)} className="text-xs font-medium text-muted-foreground hover:text-foreground">
            Need a person? Contact support
          </button>
        </form>
      )}
      <div ref={endRef} />
    </div>
  );
}

// ── Panel + trigger ───────────────────────────────────────────────────────────

export function HelpPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { organizationId } = useOrg();
  const [tab, setTab] = useState<Tab>("articles");
  const [openArticleId, setOpenArticleId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const sessionId = useMemo(() => newHelpSessionId(), []);
  const canAsk = Boolean(organizationId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col gap-0">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border text-left">
          <SheetTitle className="flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-primary" aria-hidden="true" /> Help
          </SheetTitle>
          <SheetDescription>Guides for EmpireVu, and answers to your questions.</SheetDescription>
        </SheetHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v === "ask" ? "ask" : "articles")} className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-5 mt-3 grid grid-cols-2">
            <TabsTrigger value="articles">Articles</TabsTrigger>
            <TabsTrigger value="ask" disabled={!canAsk}>
              Ask a question
            </TabsTrigger>
          </TabsList>
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            <TabsContent value="articles" className="mt-0">
              <ArticlesTab
                openArticleId={openArticleId}
                setOpenArticleId={setOpenArticleId}
                onAsk={(question) => {
                  setDraft(question);
                  setTab("ask");
                }}
              />
            </TabsContent>
            <TabsContent value="ask" className="mt-0">
              {canAsk ? (
                <AskTab
                  orgId={organizationId}
                  sessionId={sessionId}
                  draft={draft}
                  setDraft={setDraft}
                  messages={messages}
                  setMessages={setMessages}
                  onOpenArticle={(id) => {
                    setOpenArticleId(id);
                    setTab("articles");
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Finish creating your organization to ask questions.</p>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

/** The "Help" entry point. Icon-only on small screens (with an accessible name), labelled from sm up. */
export function HelpButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Help"
        aria-haspopup="dialog"
        className={cn(
          "flex items-center gap-1.5 p-2 sm:px-3 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors",
          className,
        )}
      >
        <HelpCircle className="w-[18px] h-[18px]" aria-hidden="true" />
        <span className="hidden sm:inline">Help</span>
      </button>
      <HelpPanel open={open} onOpenChange={setOpen} />
    </>
  );
}
