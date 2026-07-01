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

const VERSION = "2.3.0";

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

// ─── Tool 6: Format text (bold / italic / strikethrough / underline) ──────────

server.registerTool(
  "gdocs_format_text",
  {
    title: "Format Text in Tab",
    description: `Apply character formatting (bold, italic, strikethrough, underline) to the first occurrence of a string in a tab.
Reuses the same range-finding as find_replace, but changes STYLE instead of content. Ideal for striking through a line when a to-do item is done.
Args:
  - tab_name: Exact tab name. Optional when the doc has a single tab.
  - find_text: Exact text to style (first match).
  - bold / italic / strikethrough / underline: Optional booleans. Pass true to turn a style on, false to turn it off. Omitted styles are left unchanged.
  - doc: A Google Doc URL or ID; "todo" (default) and "radhika" are shortcuts.
Returns: Confirmation, or an error if the string was not found.`,
    inputSchema: z.object({
      tab_name: z.string().optional().describe("Exact tab name. Optional if the doc has only one tab."),
      find_text: z.string().min(1).describe("Exact text to style (first match)"),
      bold: z.boolean().optional().describe("Set bold on/off"),
      italic: z.boolean().optional().describe("Set italic on/off"),
      strikethrough: z.boolean().optional().describe("Set strikethrough on/off"),
      underline: z.boolean().optional().describe("Set underline on/off"),
      doc: docArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tab_name, find_text, bold, italic, strikethrough, underline, doc }) => {
    const { docId, error } = resolveDocId(doc);
    if (error) return { content: [{ type: "text", text: error }] };
    const docData = await docsGet(docId);
    const { tab, error: tabErr } = resolveTab(docData, tab_name);
    if (!tab) return { content: [{ type: "text", text: tabErr ?? "Tab not found." }] };

    const location = findTextInTab(tab, find_text);
    if (!location) {
      return { content: [{ type: "text", text: `Could not find "${find_text}" in tab "${tab.tabProperties.title}".` }] };
    }

    const textStyle: Record<string, boolean> = {};
    const fields: string[] = [];
    if (bold !== undefined) { textStyle.bold = bold; fields.push("bold"); }
    if (italic !== undefined) { textStyle.italic = italic; fields.push("italic"); }
    if (strikethrough !== undefined) { textStyle.strikethrough = strikethrough; fields.push("strikethrough"); }
    if (underline !== undefined) { textStyle.underline = underline; fields.push("underline"); }

    if (fields.length === 0) {
      return { content: [{ type: "text", text: "No styles specified. Pass at least one of bold, italic, strikethrough, underline." }] };
    }

    const tabId = tab.tabProperties.tabId;
    await docsBatchUpdate(docId, [
      {
        updateTextStyle: {
          range: { startIndex: location.startIndex, endIndex: location.endIndex, tabId },
          textStyle,
          fields: fields.join(","),
        },
      },
    ]);

    return { content: [{ type: "text", text: `Styled "${find_text}" in "${tab.tabProperties.title}" (${fields.join(", ")}).` }] };
  }
);

// ─── Tool 7: Make bullets / numbered list ─────────────────────────────────────

server.registerTool(
  "gdocs_make_bullets",
  {
    title: "Convert Paragraphs to Native Bullets",
    description: `Turn one or more existing paragraphs into a real, native bulleted or numbered list. Applies to every paragraph the range touches.
Args:
  - tab_name: Exact tab name. Optional when the doc has a single tab.
  - start_text: Text on the FIRST line to bullet (first match).
  - end_text: Optional text on the LAST line to bullet. Omit to bullet only the start line. Pass the first and last item to bullet a whole section at once.
  - preset: Optional bullet style. Default "BULLET_DISC_CIRCLE_SQUARE" (round bullets). Other options include "BULLET_CHECKBOX", "BULLET_ARROW_DIAMOND_DISC", "NUMBERED_DECIMAL_ALPHA_ROMAN".
  - doc: A Google Doc URL or ID; "todo" (default) and "radhika" are shortcuts.
Returns: Confirmation, or an error if the text was not found.`,
    inputSchema: z.object({
      tab_name: z.string().optional().describe("Exact tab name. Optional if the doc has only one tab."),
      start_text: z.string().min(1).describe("Text on the first line to bullet"),
      end_text: z.string().optional().describe("Text on the last line to bullet (omit for a single line)"),
      preset: z.string().optional().describe('Bullet preset. Default "BULLET_DISC_CIRCLE_SQUARE".'),
      doc: docArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tab_name, start_text, end_text, preset, doc }) => {
    const { docId, error } = resolveDocId(doc);
    if (error) return { content: [{ type: "text", text: error }] };
    const docData = await docsGet(docId);
    const { tab, error: tabErr } = resolveTab(docData, tab_name);
    if (!tab) return { content: [{ type: "text", text: tabErr ?? "Tab not found." }] };

    const startLoc = findTextInTab(tab, start_text);
    if (!startLoc) {
      return { content: [{ type: "text", text: `Could not find "${start_text}" in tab "${tab.tabProperties.title}".` }] };
    }
    let endIndex = startLoc.endIndex;
    if (end_text) {
      const endLoc = findTextInTab(tab, end_text);
      if (!endLoc) {
        return { content: [{ type: "text", text: `Could not find end_text "${end_text}" in tab "${tab.tabProperties.title}".` }] };
      }
      endIndex = Math.max(endIndex, endLoc.endIndex);
    }

    const tabId = tab.tabProperties.tabId;
    await docsBatchUpdate(docId, [
      {
        createParagraphBullets: {
          range: { startIndex: startLoc.startIndex, endIndex, tabId },
          bulletPreset: preset || "BULLET_DISC_CIRCLE_SQUARE",
        },
      },
    ]);

    return { content: [{ type: "text", text: `Applied bullets (${preset || "BULLET_DISC_CIRCLE_SQUARE"}) in "${tab.tabProperties.title}".` }] };
  }
);

// ─── Tool 8: Remove bullets ───────────────────────────────────────────────────

server.registerTool(
  "gdocs_remove_bullets",
  {
    title: "Remove Native Bullets",
    description: `Strip native bullet/number formatting from paragraphs in a range, turning them back into plain paragraphs. Reverses gdocs_make_bullets.
Args:
  - tab_name: Exact tab name. Optional when the doc has a single tab.
  - start_text: Text on the first line to unbullet (first match).
  - end_text: Optional text on the last line. Omit to unbullet only the start line.
  - doc: A Google Doc URL or ID; "todo" (default) and "radhika" are shortcuts.
Returns: Confirmation, or an error if the text was not found.`,
    inputSchema: z.object({
      tab_name: z.string().optional().describe("Exact tab name. Optional if the doc has only one tab."),
      start_text: z.string().min(1).describe("Text on the first line to unbullet"),
      end_text: z.string().optional().describe("Text on the last line to unbullet (omit for a single line)"),
      doc: docArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tab_name, start_text, end_text, doc }) => {
    const { docId, error } = resolveDocId(doc);
    if (error) return { content: [{ type: "text", text: error }] };
    const docData = await docsGet(docId);
    const { tab, error: tabErr } = resolveTab(docData, tab_name);
    if (!tab) return { content: [{ type: "text", text: tabErr ?? "Tab not found." }] };

    const startLoc = findTextInTab(tab, start_text);
    if (!startLoc) {
      return { content: [{ type: "text", text: `Could not find "${start_text}" in tab "${tab.tabProperties.title}".` }] };
    }
    let endIndex = startLoc.endIndex;
    if (end_text) {
      const endLoc = findTextInTab(tab, end_text);
      if (!endLoc) {
        return { content: [{ type: "text", text: `Could not find end_text "${end_text}" in tab "${tab.tabProperties.title}".` }] };
      }
      endIndex = Math.max(endIndex, endLoc.endIndex);
    }

    const tabId = tab.tabProperties.tabId;
    await docsBatchUpdate(docId, [
      {
        deleteParagraphBullets: {
          range: { startIndex: startLoc.startIndex, endIndex, tabId },
        },
      },
    ]);

    return { content: [{ type: "text", text: `Removed bullets in "${tab.tabProperties.title}".` }] };
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
