import { useEffect } from "react";

/**
 * Set the browser tab title while a public, customer-facing page is mounted, restoring the
 * previous title on unmount. Customer pages are titled with the CLIENT's business name,
 * never the platform's (docs/branding.md).
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
