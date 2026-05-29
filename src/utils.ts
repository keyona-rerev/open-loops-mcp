import {
  DocsDocument,
  DocsTab,
  StructuralElement,
  Paragraph,
} from "./docsClient";

export const DOC_ID =
  process.env.OPEN_LOOPS_DOC_ID || "1TgwkOUKyZH36uBmK4fkgwA6fmxihx5IduEapqr0EGRo";

export const SECTION_HEADERS = ["TASKS", "PROJECTS", "THREADS"] as const;
export type SectionType = (typeof SECTION_HEADERS)[number];

export type ItemStatus = "OPEN" | "WAITING" | "DONE" | "DROPPED";

export function findTab(doc: DocsDocument, tabName: string): DocsTab | null {
  if (!doc.tabs) return null;
  const name = tabName.trim().toLowerCase();
  return (
    doc.tabs.find((t) => t.tabProperties.title.trim().toLowerCase() === name) ??
    null
  );
}

export function listTabNames(doc: DocsDocument): string[] {
  return (doc.tabs ?? []).map((t) => t.tabProperties.title);
}

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

export interface ParsedItem {
  raw: string;
  type: SectionType;
  status: ItemStatus;
  text: string;
  notes: string;
  addedDate: string;
}

const SECTION_MARKER_RE = /──\s*(TASKS|PROJECTS|THREADS)\s*──/;

export function parseTabItems(tabText: string): ParsedItem[] {
  const lines = tabText.split("\n");
  const items: ParsedItem[] = [];
  let currentSection: SectionType | null = null;

  for (const line of lines) {
    const sectionMatch = line.match(SECTION_MARKER_RE);
    if (sectionMatch) {
      currentSection = sectionMatch[1] as SectionType;
      continue;
    }
    if (!currentSection) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed === "(nothing yet)") continue;

    const itemMatch = trimmed.match(
      /^\[(.)\]\s+(.+?)(?:\s+\(([^)]*)\))?\s+\[(OPEN|WAITING|DONE|DROPPED)[^\]]*\]$/
    );
    if (itemMatch) {
      const [, , text, notes, status] = itemMatch;
      const addedMatch = trimmed.match(/added\s+([\d/]+)/);
      items.push({
        raw: line,
        type: currentSection,
        status: status as ItemStatus,
        text: text.trim(),
        notes: notes?.trim() ?? "",
        addedDate: addedMatch?.[1] ?? "",
      });
    }
  }

  return items;
}

export function filterOpen(items: ParsedItem[]): ParsedItem[] {
  return items.filter((i) => i.status === "OPEN" || i.status === "WAITING");
}

export interface SectionBounds {
  insertBeforeIndex: number;
  hasPlaceholder: boolean;
  placeholderStart: number;
  placeholderEnd: number;
}

export function findSectionInsertPoint(
  tab: DocsTab,
  section: SectionType
): SectionBounds | null {
  const content = tab.documentTab?.body?.content ?? [];

  const paras: Array<{ text: string; start: number; end: number }> = [];
  for (const el of content) {
    if (!el.paragraph || el.startIndex === undefined || el.endIndex === undefined)
      continue;
    const text = paragraphToText(el.paragraph);
    paras.push({ text, start: el.startIndex, end: el.endIndex });
  }

  const headerIdx = paras.findIndex(
    (p) => p.text.includes(`── ${section} ──`) || (SECTION_MARKER_RE.test(p.text) && p.text.includes(section))
  );
  if (headerIdx === -1) return null;

  const nextSectionIdx = paras.findIndex(
    (p, i) => i > headerIdx && SECTION_MARKER_RE.test(p.text)
  );
  const endIdx = nextSectionIdx === -1 ? paras.length : nextSectionIdx;

  const sectionParas = paras.slice(headerIdx + 1, endIdx);
  const placeholderPara = sectionParas.find((p) => p.text.trim() === "(nothing yet)");

  if (placeholderPara) {
    return {
      insertBeforeIndex: placeholderPara.start,
      hasPlaceholder: true,
      placeholderStart: placeholderPara.start,
      placeholderEnd: placeholderPara.end,
    };
  }

  const lastItemPara = [...sectionParas].reverse().find((p) => p.text.trim());
  const insertPoint = lastItemPara ? lastItemPara.end : paras[headerIdx].end;

  return {
    insertBeforeIndex: insertPoint,
    hasPlaceholder: false,
    placeholderStart: -1,
    placeholderEnd: -1,
  };
}

export function formatItem(
  text: string,
  notes: string,
  status: ItemStatus,
  addedDate: string
): string {
  const notePart = notes ? ` (${notes})` : "";
  return `[ ] ${text}${notePart} [${status} | added ${addedDate}]\n`;
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear().toString().slice(2)}`;
}
