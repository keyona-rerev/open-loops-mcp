import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { docsGet, docsBatchUpdate } from "./docsClient";
import {
  resolveDocId,
  resolveTab,
  listTabNames,
  getTabText,
  findTextInTab,
  findInsertPointAfter,
  getTabEndIndex,
} from "./utils";

const VERSION = "2.2.0";

const server = new McpServer({
  name: "gdocs-mcp-server",
  version: VERSION,
});

// Shared selector for which document a tool should target.
const docArg = z
  .string()
  .optional()
  .describe('Which Google Doc to target. Pass a full Google Doc URL or its document ID to target ANY doc the connected Google account can edit. The shortcuts "todo" (default) and "radhika" also work. Omit to use the default todo doc.');

// ─── Tool 1: List tabs ────────────────────────────────────────────────────────

server.registerTool(
  "gdocs_list_tabs",
  {
    title: "List Document Tabs",
    description: `List all tab names in a Google Doc.
Always call this first to discover available tabs before any read or write operation.
Returns tab names exactly as they appear in the document.
Args:
  - doc: Which doc to list. A Google Doc URL or document ID targets any doc the account can access; "todo" (default) and "radhika" are optional shortcuts.`,
    inputSchema: z.object({
      doc: docArg,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ doc }) => {
    const { docId, error } = resolveDocId(doc);
    if (error) return { content: [{ type: "text", text: error }] };
    const docData = await docsGet(docId);
    const tabs = listTabNames(docData);
    return { content: [{ type: "text", text: JSON.stringify({ doc: doc || "todo", tabs }) }] };
  }
);

// ─── Tool 2: Read tab ─────────────────────────────────────────────────────────

server.registerTool(
  "gdocs_read_tab",
  {
    title: "Read Tab Content",
    description: `Read the full plain-text content of a specific tab in a Google Doc.
Call gdocs_list_tabs first to get valid tab names.
Args:
  - tab_name: Exact tab name as returned by gdocs_list_tabs. Optional when the doc has a single tab.
  - doc: A Google Doc URL or document ID targets any doc the account can access; "todo" (default) and "radhika" are optional shortcuts.
Returns: Full plain text of the tab.`,
    inputSchema: z.object({
      tab_name: z.string().optional().describe("Exact tab name as returned by gdocs_list_tabs. Optional if the doc has only one tab."),
      doc: docArg,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tab_name, doc }) => {
    const { docId, error } = resolveDocId(doc);
    if (error) return { content: [{ type: "text", text: error }] };
    const docData = await docsGet(docId);
    const { tab, error: tabErr } = resolveTab(docData, tab_name);
    if (!tab) return { content: [{ type: "text", text: tabErr ?? "Tab not found." }] };
    const text = getTabText(tab);
    return { content: [{ type: "text", text: text || "(tab is empty)" }] };
  }
);

// ─── Tool 3: Append to tab ────────────────────────────────────────────────────

server.registerTool(
  "gdocs_append_to_tab",
  {
    title: "Append Text to Tab",
    description: `Append text to the end of a specific tab in a Google Doc.
Args:
  - tab_name: Exact tab name as returned by gdocs_list_tabs. Optional when the doc has a single tab.
  - text: Text to append. Use \\n for newlines.
  - doc: A Google Doc URL or document ID targets any doc the account can edit; "todo" (default) and "radhika" are optional shortcuts.
Returns: Confirmation of what was appended.`,
    inputSchema: z.object({
      tab_name: z.string().optional().describe("Exact tab name. Optional if the doc has only one tab."),
      text: z.string().min(1).describe("Text to append. Use \\n for newlines."),
      doc: docArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tab_name, text, doc }) => {
    const { docId, error } = resolveDocId(doc);
    if (error) return { content: [{ type: "text", text: error }] };
    const docData = await docsGet(docId);
    const { tab, error: tabErr } = resolveTab(docData, tab_name);
    if (!tab) return { content: [{ type: "text", text: tabErr ?? "Tab not found." }] };

    const insertIndex = getTabEndIndex(tab);
    if (insertIndex === null) {
      return { content: [{ type: "text", text: `Could not determine insert position in tab "${tab.tabProperties.title}".` }] };
    }

    const tabId = tab.tabProperties.tabId;
    await docsBatchUpdate(docId, [
      { insertText: { text, location: { index: insertIndex, tabId } } },
    ]);

    return { content: [{ type: "text", text: `Appended to "${tab.tabProperties.title}":\n${text}` }] };
  }
);

// ─── Tool 4: Insert after text ────────────────────────────────────────────────

server.registerTool(
  "gdocs_insert_after",
  {
    title: "Insert Text After String",
    description: `Insert text immediately after the first occurrence of a specific string in a tab.
Useful for inserting a new line after a section header or a specific existing line.
Args:
  - tab_name: Exact tab name. Optional when the doc has a single tab.
  - after_text: The string to search for — new text will be inserted immediately after it
  - insert_text: Text to insert. Use \\n for newlines.
  - doc: A Google Doc URL or document ID targets any doc the account can edit; "todo" (default) and "radhika" are optional shortcuts.
Returns: Confirmation, or an error if the search string was not found.`,
    inputSchema: z.object({
      tab_name: z.string().optional().describe("Exact tab name. Optional if the doc has only one tab."),
      after_text: z.string().min(1).describe("String to insert after (first match)"),
      insert_text: z.string().min(1).describe("Text to insert after the match"),
      doc: docArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tab_name, after_text, insert_text, doc }) => {
    const { docId, error } = resolveDocId(doc);
    if (error) return { content: [{ type: "text", text: error }] };
    const docData = await docsGet(docId);
    const { tab, error: tabErr } = resolveTab(docData, tab_name);
    if (!tab) return { content: [{ type: "text", text: tabErr ?? "Tab not found." }] };

    const insertIndex = findInsertPointAfter(tab, after_text);
    if (insertIndex === null) {
      return { content: [{ type: "text", text: `Could not find "${after_text}" in tab "${tab.tabProperties.title}".` }] };
    }

    const tabId = tab.tabProperties.tabId;
    await docsBatchUpdate(docId, [
      { insertText: { text: insert_text, location: { index: insertIndex, tabId } } },
    ]);

    return { content: [{ type: "text", text: `Inserted after "${after_text}" in "${tab.tabProperties.title}":\n${insert_text}` }] };
  }
);

// ─── Tool 5: Find and replace ─────────────────────────────────────────────────

server.registerTool(
  "gdocs_find_replace",
  {
    title: "Find and Replace Text in Tab",
    description: `Find a specific string in a tab and replace it with new text.
Replaces the first occurrence only. Use for updating existing lines — marking items done, changing status, updating notes.
Args:
  - tab_name: Exact tab name. Optional when the doc has a single tab.
  - find_text: Exact text to find (must match exactly including spacing)
  - replace_text: Text to replace it with. Use empty string to delete.
  - doc: A Google Doc URL or document ID targets any doc the account can edit; "todo" (default) and "radhika" are optional shortcuts.
Returns: Confirmation showing what was replaced, or an error if not found.`,
    inputSchema: z.object({
      tab_name: z.string().optional().describe("Exact tab name. Optional if the doc has only one tab."),
      find_text: z.string().min(1).describe("Exact text to find"),
      replace_text: z.string().describe("Replacement text (empty string to delete)"),
      doc: docArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tab_name, find_text, replace_text, doc }) => {
    const { docId, error } = resolveDocId(doc);
    if (error) return { content: [{ type: "text", text: error }] };
    const docData = await docsGet(docId);
    const { tab, error: tabErr } = resolveTab(docData, tab_name);
    if (!tab) return { content: [{ type: "text", text: tabErr ?? "Tab not found." }] };

    const location = findTextInTab(tab, find_text);
    if (!location) {
      return { content: [{ type: "text", text: `Could not find "${find_text}" in tab "${tab.tabProperties.title}".` }] };
    }

    const tabId = tab.tabProperties.tabId;
    const requests: unknown[] = [
      {
        deleteContentRange: {
          range: { startIndex: location.startIndex, endIndex: location.endIndex, tabId },
        },
      },
    ];

    if (replace_text.length > 0) {
      requests.push({
        insertText: {
          text: replace_text,
          location: { index: location.startIndex, tabId },
        },
      });
    }

    await docsBatchUpdate(docId, requests);
    return {
      content: [{
        type: "text",
        text: `Replaced in "${tab.tabProperties.title}":\nBefore: ${find_text}\nAfter:  ${replace_text || "(deleted)"}`,
      }],
    };
  }
);

// ─── HTTP server ──────────────────────────────────────────────────────────────

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "gdocs-mcp-server", version: VERSION });
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
    console.error(`Google Docs MCP v${VERSION} running on port ${port}`);
  });
}

runHTTP().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
