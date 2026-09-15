import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("plugin opens the board only through its MCP App entrypoint", async () => {
  const [skill, manifestText, mcpText] = await Promise.all([
    readFile(resolve(ROOT, "skills/open-conversation-board/SKILL.md"), "utf8"),
    readFile(resolve(ROOT, ".codex-plugin/plugin.json"), "utf8"),
    readFile(resolve(ROOT, ".mcp.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const mcp = JSON.parse(mcpText);

  assert.equal((skill.match(/\bshow_board\b/g) || []).length, 1);
  assert.match(skill, /Open only the returned MCP App/);
  assert.match(manifest.description, /MCP App/);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(mcp.mcpServers.conversationBoard.command, "./scripts/launch-mcp-server");
  assert.deepEqual(mcp.mcpServers.conversationBoard.args, ["./server/server.mjs"]);
  assert.ok(mcp.mcpServers.conversationBoard.env_vars.includes("CODEX_APP_TOOLS_PIPE_PATH"));
  assert.doesNotMatch(mcpText, /(?:file:\/\/|board\.html|open_in_codex)/);
});
