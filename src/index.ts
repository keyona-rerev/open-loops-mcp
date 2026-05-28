import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { docsGet, docsBatchUpdate } from "./docsClient.js";
import {
  DOC_ID,
  VENTURE_TABS,
  SECTION_HEADERS,
  SectionType,
  findTab,
  listTabNames,
  getTabText,
  parseTabItems,
  filterOpen,
  findSectionInsertPoint,
  formatItem,
  todayStr,
  paragraphToText,
} from "./utils.js";

const server = new McpServer({
  name: "open-loops-mcp-server",
  version: "1.0.0",
});

server.registerTool(
  "open_loops_list_tabs",
  {
    title: "List Open Loops Tabs",
    description: `List all tab names in Keyona's Open Loops Google Doc.
Returns the current tab names so you know what's available before reading or writing.
Tabs: ReRev Labs, Black Tech Capital, Prismm, Sekhmetic, Personal.`,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const doc = await docsGet(DOC_ID);
    const tabs = listTabNames(doc);
    return { content: [{ type: "text", text: JSON.stringify({ tabs }) }] };
  }
);

server.registerTool(
  "open_loops_read_tab",
  {
    title: "Read Open Loops Tab",
    description: `Read the full text content of a specific tab in the Open Loops doc.
Args:
  - tab_name: One of: ${VENTURE_TABS.join(", ")}
Returns: Full text of the tab with all Tasks, Projects, and Threads.`,
    inputSchema: z.object({
      tab_name: z.string().describe(`Venture tab. One of: ${VENTURE_TABS.join(", ")}`),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tab_name }) => {
    const doc = await docsGet(DOC_ID);
    const tab = findTab(doc, tab_name);
    if (!tab) {
      return { content: [{ type: "text", text: `Tab "${tab_name}" not found. Available: ${listTabNames(doc).join(", ")}` }] };
    }
    return { content: [{ type: "text", text: getTabText(tab) || "(empty)" }] };
  }
);

server.registerTool(
  "open_loops_get_open_items",
  {
    title: "Get Open Items",
    description: `Get all OPEN and WAITING items from one or all venture tabs.
Args:
  - tab_name: (optional) Filter to one tab. Omit for all tabs.
Returns: Items grouped by tab and section (TASKS/PROJECTS/THREADS).`,
    inputSchema: z.object({
      tab_name: z.string().optional().describe("Optional venture tab name. Omit for all."),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tab_name }) => {
    const doc = await docsGet(DOC_ID);
    const tabsToRead = tab_name ? [findTab(doc, tab_name)].filter(Boolean) : (doc.tabs ?? []);
    const result: Record<string, Record<string, unknown[]>> = {};

    for (const tab of tabsToRead) {
      if (!tab) continue;
      const title = tab.tabProperties.title;
      const open = filterOpen(parseTabItems(getTabText(tab)));
      if (open.length === 0) continue;
      result[title] = { TASKS: [], PROJECTS: [], THREADS: [] };
      for (const item of open) {
        result[title][item.type].push({ status: item.status, text: item.text, notes: item.notes, added: item.addedDate });
      }
      for (const sec of SECTION_HEADERS) {
        if ((result[title][sec] as unknown[]).length === 0) delete result[title][sec];
      }
      if (Object.keys(result[title]).length === 0) delete result[title];
    }

    if (Object.keys(result).length === 0) {
      return { content: [{ type: "text", text: "No open or waiting items found." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "open_loops_append_item",
  {
    title: "Append Item to Open Loops",
    description: `Add a Task, Project, or Thread to the correct section of a venture tab.
Args:
  - tab_name: One of: ${VENTURE_TABS.join(", ")}
  - section: TASKS, PROJECTS, or THREADS
  - text: Item description
  - notes: Context, next action, or follow-up date (for threads)
  - status: OPEN or WAITING
Returns: Confirmation of what was added.`,
    inputSchema: z.object({
      tab_name: z.string().describe(`Venture tab. One of: ${VENTURE_TABS.join(", ")}`),
      section: z.enum(SECTION_HEADERS).describe("TASKS, PROJECTS, or THREADS"),
      text: z.string().min(1).describe("Item description"),
      notes: z.string().optional().default("").describe("Context or next action"),
      status: z.enum(["OPEN", "WAITING"]).optional().default("OPEN"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tab_name, section, text, notes, status }) => {
    const doc = await docsGet(DOC_ID);
    const tab = findTab(doc, tab_name);
    if (!tab) {
      return { content: [{ type: "text", text: `Tab "${tab_name}" not found. Available: ${listTabNames(doc).join(", ")}` }] };
    }

    const bounds = findSectionInsertPoint(tab, section as SectionType);
    if (!bounds) {
      return { content: [{ type: "text", text: `Could not find section "${section}" in tab "${tab_name}".` }] };
    }

    const itemText = formatItem(text, notes ?? "", status, todayStr());
    const tabId = tab.tabProperties.tabId;
    const requests: unknown[] = [];

    if (bounds.hasPlaceholder) {
      requests.push({ deleteContentRange: { range: { startIndex: bounds.placeholderStart, endIndex: bounds.placeholderEnd, tabId } } });
      requests.push({ insertText: { text: itemText, location: { index: bounds.placeholderStart, tabId } } });
    } else {
      requests.push({ insertText: { text: itemText, location: { index: bounds.insertBeforeIndex, tabId } } });
    }

    await docsBatchUpdate(DOC_ID, requests);
    return { content: [{ type: "text", text: `Added to ${tab_name} / ${section}:\n${itemText.trim()}` }] };
  }
);

server.registerTool(
  "open_loops_update_item",
  {
    title: "Update Open Loops Item",
    description: `Update an existing item — mark done, dropped, or update notes.
Args:
  - tab_name: Venture tab
  - section: TASKS, PROJECTS, or THREADS
  - match_text: Partial text to identify the item
  - new_status: OPEN, WAITING, DONE, or DROPPED
  - new_notes: (optional) Updated notes
Returns: Before/after confirmation.`,
    inputSchema: z.object({
      tab_name: z.string().describe("Venture tab name"),
      section: z.enum(SECTION_HEADERS).describe("TASKS, PROJECTS, or THREADS"),
      match_text: z.string().min(3).describe("Partial item text to match"),
      new_status: z.enum(["OPEN", "WAITING", "DONE", "DROPPED"]),
      new_notes: z.string().optional().describe("Updated notes (optional)"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tab_name, section, match_text, new_status, new_notes }) => {
    const doc = await docsGet(DOC_ID);
    const tab = findTab(doc, tab_name);
    if (!tab) return { content: [{ type: "text", text: `Tab "${tab_name}" not found.` }] };

    const content = tab.documentTab?.body?.content ?? [];
    const lowerMatch = match_text.toLowerCase();
    const SECTION_RE = /──\s*(TASKS|PROJECTS|THREADS)\s*──/;
    let inTargetSection = false;
    let targetPara: { text: string; start: number; end: number } | null = null;

    for (const el of content) {
      if (!el.paragraph || el.startIndex === undefined || el.endIndex === undefined) continue;
      const paraText = paragraphToText(el.paragraph);
      const sectionMatch = paraText.match(SECTION_RE);
      if (sectionMatch) { inTargetSection = sectionMatch[1] === section; continue; }
      if (inTargetSection && paraText.toLowerCase().includes(lowerMatch)) {
        targetPara = { text: paraText, start: el.startIndex, end: el.endIndex };
        break;
      }
    }

    if (!targetPara) {
      return { content: [{ type: "text", text: `Could not find "${match_text}" in ${tab_name} / ${section}.` }] };
    }

    const existingItems = parseTabItems(targetPara.text);
    const existingItem = existingItems[0];
    const itemText = existingItem?.text ?? match_text;
    const notesToUse = new_notes !== undefined ? new_notes : (existingItem?.notes ?? "");
    const addedDate = existingItem?.addedDate ?? todayStr();
    const notePart = notesToUse ? ` (${notesToUse})` : "";

    let newLine: string;
    if (new_status === "DONE") {
      newLine = `[x] ${itemText}${notePart} [DONE | ${todayStr()}]\n`;
    } else if (new_status === "DROPPED") {
      newLine = `[-] ${itemText}${notePart} [DROPPED | ${todayStr()}]\n`;
    } else {
      newLine = formatItem(itemText, notesToUse, new_status, addedDate);
    }

    const tabId = tab.tabProperties.tabId;
    await docsBatchUpdate(DOC_ID, [
      { deleteContentRange: { range: { startIndex: targetPara.start, endIndex: targetPara.end, tabId } } },
      { insertText: { text: newLine, location: { index: targetPara.start, tabId } } },
    ]);

    return { content: [{ type: "text", text: `Updated in ${tab_name} / ${section}:\nBefore: ${targetPara.text.trim()}\nAfter:  ${newLine.trim()}` }] };
  }
);

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "open-loops-mcp-server" });
  });

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000");
  app.listen(port, () => {
    console.error(`Open Loops MCP running on port ${port}`);
  });
}

runHTTP().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
