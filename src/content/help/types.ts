/**
 * Customer help articles (docs/help-assistant.md).
 *
 * Plain data shared by the SPA (Help panel search + reading) and the server (the Ask
 * endpoint retrieves sections from these and nothing else). Written for a non-technical
 * business owner; every claim is checked against what the app actually does.
 *
 * Body format (rendered by HelpArticleBody, and fed to the model as-is):
 *  - each plain line is a paragraph (blank lines are just spacing);
 *  - a line starting with "- " is a bullet, "1. " a numbered step;
 *  - `code` in backticks is shown as a code chip (e.g. forwarding codes).
 */
export interface HelpSection {
  heading: string;
  body: string;
}

export interface HelpArticle {
  /** Stable id — cited by the assistant and stored in help_chat_events metadata. */
  id: string;
  title: string;
  /** One line shown in the list and used as a retrieval boost. */
  summary: string;
  /** Extra search words (synonyms people actually type). */
  keywords: string[];
  sections: HelpSection[];
}
