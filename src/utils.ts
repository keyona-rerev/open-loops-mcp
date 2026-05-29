import {
  DocsDocument,
  DocsTab,
  StructuralElement,
  Paragraph,
} from "./docsClient";

export const DOC_ID = process.env.GDOCS_DOC_ID || "";

// ─── Tab helpers ──────────────────────────────────────────────────────────────

export function findTab(doc: DocsDocument, tabName: string): DocsTab | null {
  if (!doc.tabs) return null;
  const name = tabName.trim().toLowerCase();
  return doc.tabs.find((t) => t.tabProperties.title.trim().toLowerCase() === name) ?? null;
}

export function listTabNames(doc: DocsDocument): string[] {
  return (doc.tabs ?? []).map((t) => t.tabProperties.title);
}

// ─── Content extraction ───────────────────────────────────────────────────────

export function getTabText(tab: DocsTab): string {
  const content = tab.documentTab?.body?.content ?? [];
  return content
    .map(elementToText)
    .join("")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function elementToText(el: StructuralElement): string {
  if (!el.paragraph) return "";
  return paragraphToText(el.paragraph);
}

export function paragraphToText(para: Paragraph): string {
  return para.elements.map((e) => e.textRun?.content ?? "").join("");
}

// ─── Index finding ────────────────────────────────────────────────────────────

export interface TextLocation {
  startIndex: number;
  endIndex: number;
}

/**
 * Find the character range of a specific string within a tab's content.
 * Returns the first match. Used for find-and-replace operations.
 */
export function findTextInTab(tab: DocsTab, searchText: string): TextLocation | null {
  const content = tab.documentTab?.body?.content ?? [];
  const lower = searchText.toLowerCase();

  for (const el of content) {
    if (!el.paragraph || el.startIndex === undefined) continue;
    const paraText = paragraphToText(el.paragraph);
    const idx = paraText.toLowerCase().indexOf(lower);
    if (idx !== -1) {
      const base = el.startIndex;
      return {
        startIndex: base + idx,
        endIndex: base + idx + searchText.length,
      };
    }
  }
  return null;
}

/**
 * Find the end index of a paragraph containing searchText.
 * Used to insert text after a specific line.
 */
export function findInsertPointAfter(tab: DocsTab, searchText: string): number | null {
  const content = tab.documentTab?.body?.content ?? [];
  const lower = searchText.toLowerCase();

  for (const el of content) {
    if (!el.paragraph || el.endIndex === undefined) continue;
    const paraText = paragraphToText(el.paragraph);
    if (paraText.toLowerCase().includes(lower)) {
      return el.endIndex;
    }
  }
  return null;
}

/**
 * Get the end index of the last paragraph in a tab — for appending.
 * Subtract 1 to insert before the final newline.
 */
export function getTabEndIndex(tab: DocsTab): number | null {
  const content = tab.documentTab?.body?.content ?? [];
  let lastEnd: number | null = null;
  for (const el of content) {
    if (el.endIndex !== undefined) lastEnd = el.endIndex;
  }
  // Insert before the very last character (body always ends with \n)
  return lastEnd !== null ? lastEnd - 1 : null;
}
