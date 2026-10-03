import { HELP_ARTICLES } from "@/content/help/articles";
import type { HelpArticle, HelpSection } from "@/content/help/types";

/**
 * Keyword retrieval over the help articles — BM25 on article SECTIONS (no vector DB).
 *
 * Pure and deterministic, so the SPA (Help panel search) and the server (the Ask endpoint's
 * retrieval) rank identically. Each section is indexed with its article's title, summary and
 * keywords so a short section still matches its topic.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from how i if in into is it its me my of on or our " +
    "so that the their then there these this to us we what when where which who why will with you your " +
    "i'm im get got have has want need please just about any some there's whats"
  ).split(" "),
);

/** Very light stemmer: enough that "texts"/"texting"/"texted" meet "text". */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  // "invite"/"inviting", "price"/"pricing", "service"/"services" meet on the same stem.
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

export interface SectionRef {
  article: HelpArticle;
  sectionIndex: number;
  section: HelpSection;
}

interface IndexedDoc extends SectionRef {
  termFreq: Map<string, number>;
  length: number;
}

export interface HelpIndex {
  docs: IndexedDoc[];
  docFreq: Map<string, number>;
  avgLength: number;
}

const K1 = 1.2;
const B = 0.75;

export function buildHelpIndex(articles: readonly HelpArticle[]): HelpIndex {
  const docs: IndexedDoc[] = [];
  const docFreq = new Map<string, number>();

  for (const article of articles) {
    // Title counts twice: a question that names the topic should land on that article.
    const articleText = `${article.title} ${article.title} ${article.summary} ${article.keywords.join(" ")}`;
    article.sections.forEach((section, sectionIndex) => {
      const tokens = tokenize(`${articleText} ${section.heading} ${section.heading} ${section.body}`);
      const termFreq = new Map<string, number>();
      for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
      for (const term of termFreq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      docs.push({ article, sectionIndex, section, termFreq, length: tokens.length });
    });
  }

  const avgLength = docs.length ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 0;
  return { docs, docFreq, avgLength };
}

export interface ScoredSection extends SectionRef {
  score: number;
}

/** BM25 score for every section with at least one query term, best first. */
export function searchHelpSections(index: HelpIndex, query: string): ScoredSection[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const total = index.docs.length;
  const results: Array<ScoredSection & { order: number }> = [];

  index.docs.forEach((doc, order) => {
    let score = 0;
    for (const term of terms) {
      const tf = doc.termFreq.get(term);
      if (!tf) continue;
      const df = index.docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / (index.avgLength || 1)));
    }
    if (score > 0) {
      results.push({ article: doc.article, sectionIndex: doc.sectionIndex, section: doc.section, score, order });
    }
  });

  // Stable tie-break on library order so results never shuffle between runs.
  return results
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ article, sectionIndex, section, score }) => ({ article, sectionIndex, section, score }));
}

export interface ScoredArticle {
  article: HelpArticle;
  score: number;
}

/** Articles ranked by their best-matching section (the Help panel's search list). */
export function searchHelpArticles(index: HelpIndex, query: string): ScoredArticle[] {
  const best = new Map<string, ScoredArticle>();
  for (const hit of searchHelpSections(index, query)) {
    if (!best.has(hit.article.id)) best.set(hit.article.id, { article: hit.article, score: hit.score });
  }
  return [...best.values()];
}

export interface RetrieveOptions {
  /** Max sections handed to the model. */
  maxSections?: number;
  /** Drop sections scoring below this fraction of the best hit. */
  relativeCutoff?: number;
}

/**
 * The sections the Ask endpoint gives the model: the top hits, trimmed to those reasonably
 * close to the best one. Empty = the library doesn't cover the question.
 */
export function retrieveHelpSections(
  index: HelpIndex,
  query: string,
  { maxSections = 6, relativeCutoff = 0.3 }: RetrieveOptions = {},
): ScoredSection[] {
  const hits = searchHelpSections(index, query);
  if (hits.length === 0) return [];
  const floor = hits[0].score * relativeCutoff;
  return hits.filter((hit) => hit.score >= floor).slice(0, maxSections);
}

let defaultIndex: HelpIndex | null = null;

/** The index over the shipped library, built once per process / page load. */
export function getHelpIndex(): HelpIndex {
  if (!defaultIndex) defaultIndex = buildHelpIndex(HELP_ARTICLES);
  return defaultIndex;
}
