// A stand-in for `cua-driver mcp`: the few tools Retake's session code calls,
// answering the way the real driver does (recorded from the spike), so CI
// can test the hands without a Mac.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-cua-driver", version: "0.28.2" });
const win = { app_name: "TextEdit", pid: 4242, window_id: 7078, title: "note.txt", bounds: { x: 120, y: 120, width: 960, height: 540 }, is_on_screen: true, z_index: 1 };
server.registerTool("list_windows", { inputSchema: { pid: z.number().optional() } }, async () => ({ content: [{ type: "text", text: "1 window" }], structuredContent: { windows: [win] } }));
server.registerTool("type_text", { inputSchema: { pid: z.number(), window_id: z.number().optional(), element_token: z.string().optional(), text: z.string() } }, async (a) =>
  a.element_token
    ? { content: [{ type: "text", text: `✅ Inserted ${a.text.length} char(s)` }], structuredContent: { effect: "confirmed" } }
    : { isError: true, content: [{ type: "text", text: "type_text: Background input refused (same_pid_keyboard_ambiguity): pid 4242 owns 1 other eligible top-level window(s)" }] });
await server.connect(new StdioServerTransport());
