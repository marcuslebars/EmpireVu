-- Void-and-reissue: the revision mechanic.
--
-- updateQuote deliberately refuses edits once a customer has seen a quote — the
-- amounts they were shown are what we'd owe work against. But "customer replied
-- asking for changes" is the most common event in this business, so refusing the
-- edit cannot be the end of the story.
--
-- The answer is void-and-reissue rather than mutation: cancel the quote the
-- customer saw (its public token keeps working, but renders a "this was replaced"
-- state and can never be approved), and create a successor draft pre-filled from
-- it. Both quotes stay in the record, linked in both directions, so the history of
-- what was offered when is never rewritten.
--
--   old.superseded_by -> new.id
--   new.supersedes    -> old.id
--
-- Additive: two nullable self-references plus cancellation bookkeeping.

alter table public.quotes
  add column if not exists supersedes uuid references public.quotes (id) on delete set null;
alter table public.quotes
  add column if not exists superseded_by uuid references public.quotes (id) on delete set null;

alter table public.quotes add column if not exists cancelled_at timestamptz;
alter table public.quotes add column if not exists cancel_reason text;

-- A quote can only be replaced by one successor, and can only succeed one
-- predecessor — otherwise the chain forks and "which quote is live?" stops having
-- a single answer.
create unique index if not exists quotes_superseded_by_uniq
  on public.quotes (superseded_by)
  where superseded_by is not null;

create unique index if not exists quotes_supersedes_uniq
  on public.quotes (supersedes)
  where supersedes is not null;

-- A quote must not point at itself in either direction.
alter table public.quotes drop constraint if exists quotes_no_self_supersede;
alter table public.quotes add constraint quotes_no_self_supersede
  check (
    (supersedes is null or supersedes <> id) and
    (superseded_by is null or superseded_by <> id)
  );

-- Walking a chain backwards from the live quote (admin history view).
create index if not exists quotes_supersedes_idx
  on public.quotes (supersedes)
  where supersedes is not null;
