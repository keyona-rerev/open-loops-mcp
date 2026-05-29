import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { docsGet, docsBatchUpdate } from "./docsClient";
import {
  DOC_ID,
  findTab,
  listTabNames,
  getTabText,
  findTextInTab,
  findInsertPointAfter,
  getTabEndIndex,
} from "./utils";

const server = new McpServer({
  name: "gdocs-mcp-server",
  version: "2.0.0",
});

// ─── Tool 1: List tabs ────────────────────────────────────────────────────────

server.registerTool(
  "gdocs_list_tabs",
  {
    title: "List Document Tabs",
    description: `List all tab names in a Google Doc.
Always call this first to discover available tabs before any read or write operation.
Returns tab names exactly as they appear in the document.`,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const doc = await docsGet(DOC_ID);
    const tabs = listTabNames(doc);
    return { content: [{ type: "text", text: JSON.stringify({ tabs }) }] };
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
  - tab_name: Exact tab name as returned by gdocs_list_tabs
Returns: Full plain text of the tab.`,
    inputSchema: z.object({
      tab_name: z.string().describe("Exact tab name as returned by gdocs_list_tabs"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tab_name }) => {
    const doc = await docsGet(DOC_ID);
    const tab = findTab(doc, tab_name);
    if (!tab) {
      return { content: [{ type: "text", text: `Tab "${tab_name}" not found. Available: ${listTabNames(doc).join(", ")}` }] };
    }
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
  - tab_name: Exact tab name as returned by gdocs_list_tabs
  - text: Text to append. Use \\n for newlines.
Returns: Confirmation of what was appended.`,
    inputSchema: z.object({
      tab_name: z.string().describe("Exact tab name"),
      text: z.string().min(1).describe("Text to append. Use \\n for newlines."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tab_name, text }) => {
    const doc = await docsGet(DOC_ID);
    const tab = findTab(doc, tab_name);
    if (!tab) {
      return { content: [{ type: "text", text: `Tab "${tab_name}" not found. Available: ${listTabNames(doc).join(", ")}` }] };
    }

    const insertIndex = getTabEndIndex(tab);
    if (insertIndex === null) {
      return { content: [{ type: "text", text: `Could not determine insert position in tab "${tab_name}".` }] };
    }

    const tabId = tab.tabProperties.tabId;
    await docsBatchUpdate(DOC_ID, [
      { insertText: { text, location: { index: insertIndex, tabId } } },
    ]);

    return { content: [{ type: "text", text: `Appended to "${tab_name}":\n${text}` }] };
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
  - tab_name: Exact tab name
  - after_text: The string to search for — new text will be inserted immediately after it
  - insert_text: Text to insert. Use \\n for newlines.
Returns: Confirmation, or an error if the search string was not found.`,
    inputSchema: z.object({
      tab_name: z.string().describe("Exact tab name"),
      after_text: z.string().min(1).describe("String to insert after (first match)"),
      insert_text: z.string().min(1).describe("Text to insert after the match"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tab_name, after_text, insert_text }) => {
    const doc = await docsGet(DOC_ID);
    const tab = findTab(doc, tab_name);
    if (!tab) {
      return { content: [{ type: "text", text: `Tab "${tab_name}" not found. Available: ${listTabNames(doc).join(", ")}` }] };
    }

    const insertIndex = findInsertPointAfter(tab, after_text);
    if (insertIndex === null) {
      return { content: [{ type: "text", text: `Could not find "${after_text}" in tab "${tab_name}".` }] };
    }

    const tabId = tab.tabProperties.tabId;
    await docsBatchUpdate(DOC_ID, [
      { insertText: { text: insert_text, location: { index: insertIndex, tabId } } },
    ]);

    return { content: [{ type: "text", text: `Inserted after "${after_text}" in "${tab_name}":\n${insert_text}` }] };
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
  - tab_name: Exact tab name
  - find_text: Exact text to find (must match exactly including spacing)
  - replace_text: Text to replace it with. Use empty string to delete.
Returns: Confirmation showing what was replaced, or an error if not found.`,
    inputSchema: z.object({
      tab_name: z.string().describe("Exact tab name"),
      find_text: z.string().min(1).describe("Exact text to find"),
      replace_text: z.string().describe("Replacement text (empty string to delete)"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tab_name, find_text, replace_text }) => {
    const doc = await docsGet(DOC_ID);
    const tab = findTab(doc, tab_name);
    if (!tab) {
      return { content: [{ type: "text", text: `Tab "${tab_name}" not found. Available: ${listTabNames(doc).join(", ")}` }] };
    }

    const location = findTextInTab(tab, find_text);
    if (!location) {
      return { content: [{ type: "text", text: `Could not find "${find_text}" in tab "${tab_name}".` }] };
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

    await docsBatchUpdate(DOC_ID, requests);
    return {
      content: [{
        type: "text",
        text: `Replaced in "${tab_name}":\nBefore: ${find_text}\nAfter:  ${replace_text || "(deleted)"}`,
      }],
    };
  }
);

// ─── HTTP server ──────────────────────────────────────────────────────────────

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "gdocs-mcp-server", version: "2.0.0" });
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
    console.error(`Google Docs MCP running on port ${port}`);
  });
}

runHTTP().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
