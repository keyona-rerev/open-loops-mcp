import {
  DocsDocument,
  DocsTab,
  StructuralElement,
  Paragraph,
} from "./docsClient";

export const DOC_ID = process.env.GDOCS_DOC_ID || "";

// ─── Doc registry ─────────────────────────────────────────────────────────────
// Friendly keys → Google Doc IDs, sourced from env vars on Railway.
// "todo" is the default doc (Open Loops). Add more docs by setting the matching
// env var here and redeploying — no other code changes required.
const DOC_REGISTRY: Record<string, string> = {
  todo: DOC_ID,
  radhika: process.env.GDOCS_RADHIKA_DOC_ID || "",
};

export const DEFAULT_DOC_KEY = "todo";

export function listDocKeys(): string[] {
  return Object.entries(DOC_REGISTRY)
    .filter(([, id]) => id)
    .map(([k]) => k);
}

/**
 * Resolve a doc selector to a concrete Google Doc ID.
 * Accepts a known registry key ("todo", "radhika"), or a raw Google Doc ID for
 * any doc the authenticated account can access. Defaults to the todo doc when
 * nothing is passed, preserving existing single-doc behavior.
 */
export function resolveDocId(selector?: string): { docId: string; error?: string } {
  const raw = (selector || DEFAULT_DOC_KEY).trim();
  const key = raw.toLowerCase();
  if (key in DOC_REGISTRY) {
    const id = DOC_REGISTRY[key];
    if (!id) {
      return {
        docId: "",
        error: `Doc "${raw}" is not configured on the server (missing env var). Configured docs: ${listDocKeys().join(", ") || "(none)"}.`,
      };
    }
    return { docId: id };
  }
  // Not a known key — treat the string as a raw Google Doc ID.
  return { docId: raw };
}

// ─── Tab helpers ──────────────────────────────────────────────────────────────

export function findTab(doc: DocsDocument, tabName: string): DocsTab | null {
  if (!doc.tabs) return null;
  const name = tabName.trim().toLowerCase();
  return doc.tabs.find((t) => t.tabProperties.title.trim().toLowerCase() === name) ?? null;
}

export function listTabNames(doc: DocsDocument): string[] {
  return (doc.tabs ?? []).map((t) => t.tabProperties.title);
}

/**
 * Pick the target tab within a doc.
 * - If tabName is given, match by title (case-insensitive).
 * - If tabName is omitted and the doc has exactly one tab, use that tab.
 *   (Makes single-tab docs like a call log usable without knowing the tab name.)
 * - Otherwise return an error listing the available tabs.
 */
export function resolveTab(
  doc: DocsDocument,
  tabName?: string
): { tab: DocsTab | null; error?: string } {
  const tabs = doc.tabs ?? [];
  if (tabName && tabName.trim()) {
    const tab = findTab(doc, tabName);
    if (!tab) {
      return { tab: null, error: `Tab "${tabName}" not found. Available: ${listTabNames(doc).join(", ")}` };
    }
    return { tab };
  }
  if (tabs.length === 1) return { tab: tabs[0] };
  if (tabs.length === 0) return { tab: null, error: "Document has no readable tabs." };
  return {
    tab: null,
    error: `This doc has multiple tabs; specify tab_name. Available: ${listTabNames(doc).join(", ")}`,
  };
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
