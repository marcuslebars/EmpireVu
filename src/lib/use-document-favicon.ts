import { useEffect } from "react";

/**
 * Swap the browser-tab icon while a page is mounted, restoring the app's own icons on
 * unmount. Used by the CrankLeads purchase page so a buyer coming from crankleads.com keeps
 * seeing the CrankLeads icon; the rest of the app keeps the EmpireVu favicon.
 */
export function useDocumentFavicon(href: string | null | undefined, type = "image/svg+xml"): void {
  useEffect(() => {
    if (!href) return;
    const existing = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    const saved = existing.map((link) => ({ link, href: link.getAttribute("href"), type: link.getAttribute("type") }));
    // Browsers pick among several icon links; pointing every one at the same file is the
    // only reliable way to make the swap stick.
    for (const link of existing) {
      link.setAttribute("href", href);
      link.setAttribute("type", type);
    }
    let added: HTMLLinkElement | null = null;
    if (existing.length === 0) {
      added = document.createElement("link");
      added.rel = "icon";
      added.type = type;
      added.href = href;
      document.head.appendChild(added);
    }
    return () => {
      for (const { link, href: oldHref, type: oldType } of saved) {
        if (oldHref === null) link.removeAttribute("href");
        else link.setAttribute("href", oldHref);
        if (oldType === null) link.removeAttribute("type");
        else link.setAttribute("type", oldType);
      }
      added?.remove();
    };
  }, [href, type]);
}
