# NotebookLM MCP Server (`notebooklm-mcp`) — What it is and how to use it

This document explains what the **`notebooklm-mcp`** package component is, what it can do, and how to use it **programmatically** (with a TypeScript example). It is intended to be given to **Codex** as a concise reference.

---

## 1) What is `notebooklm-mcp`?

`notebooklm-mcp` is **an MCP server executable** (not an interactive CLI command) that exposes **Google NotebookLM** operations as **MCP tools** (29 tools total) so that AI agents or other programs can control NotebookLM.

- The project distributes **two executables** from one package:
  - `nlm` — command-line interface
  - `notebooklm-mcp` — **MCP server** entrypoint (this is what we focus on)
  - Source: `pyproject.toml` (scripts section)  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/pyproject.toml

- The MCP server is implemented using **FastMCP** and registers tools from modular modules (`tools/`).
  - Source: `src/notebooklm_tools/mcp/server.py`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/server.py

### Key clarification

You *start* `notebooklm-mcp` from a terminal (because it is an executable), but you **do not “use it like a CLI”**.  
Once started, it serves an MCP interface (via stdio by default, or HTTP/SSE optionally), and a client (e.g., Claude Code / Cursor / a TypeScript program) calls its tools.

---

## 2) Authentication model (important)

NotebookLM does **not** provide an official public API in this project’s design. Instead, it authenticates by **extracting browser cookies** (and related tokens) from a Chrome session.

- Recommended auth command: `nlm login` (auto mode uses Chrome DevTools Protocol to extract cookies/tokens)
  - Source: `docs/AUTHENTICATION.md`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/docs/AUTHENTICATION.md

**Security note:** cookies/tokens are sensitive. Do not share or commit them. (The auth guide explicitly warns about this.)

---

## 3) How the server runs (transport modes)

`notebooklm-mcp` supports multiple transports:

- **stdio (default):** best for desktop tools and local subprocess integration
- **http:** “streamable-http” transport, bind host/port/path
- **sse:** legacy compatibility

CLI flags and environment variables are documented in `server.py`.

- Source: `src/notebooklm_tools/mcp/server.py`  
  https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/server.py

### Example launches

```bash
# Default (stdio)
notebooklm-mcp

# HTTP transport on localhost:8000
notebooklm-mcp --transport http --host 127.0.0.1 --port 8000 --path /mcp

# Debug logging
notebooklm-mcp --debug
```

The server also includes a health endpoint when using HTTP:
- `GET /health`
- Source: `server.py`  
  https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/server.py

---

## 4) What can it do? (29 MCP tools)

The project provides **29 MCP tools**, grouped by domain. The canonical list is in the MCP guide:

- Source: `docs/MCP_GUIDE.md`  
  https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/docs/MCP_GUIDE.md

### Most-used capabilities

#### Notebook management
- `notebook_list`, `notebook_create`, `notebook_get`, `notebook_describe`, `notebook_rename`, `notebook_delete`
- Implementation example:
  - `src/notebooklm_tools/mcp/tools/notebooks.py`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/notebooks.py

#### Source ingestion (unified)
- **`source_add`** is a *unified* tool for adding:
  - URL (web / YouTube)
  - Text
  - Google Drive documents
  - Local files (PDF, etc.)
- It supports `wait=true` to block until NotebookLM finishes processing the source.
- Source:
  - `src/notebooklm_tools/mcp/tools/sources.py`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/sources.py

#### Ask questions over sources
- `notebook_query` (queries existing sources already in the notebook)
- `chat_configure` (set chat “goal” and response length)
- Source:
  - `src/notebooklm_tools/mcp/tools/chat.py`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/chat.py

#### Studio artifact generation (unified)
- **`studio_create`** is a *unified* tool that can create:
  - audio podcast, video overview, report, quiz, flashcards, mind map, slide deck, infographic, data table
- **Confirmation gate:** Many generation operations require `confirm=true`.  
  If `confirm=false`, it returns a preview (`pending_confirmation`) describing settings to confirm.
- `studio_status` to poll completion and retrieve artifact IDs/URLs.
- Source:
  - `src/notebooklm_tools/mcp/tools/studio.py`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/studio.py

#### Downloads (unified)
- **`download_artifact`** downloads any artifact type to a local path.
- Source:
  - `src/notebooklm_tools/mcp/tools/downloads.py`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/downloads.py

---

## 5) Common workflow

1. Authenticate (one-time / when cookies expire): `nlm login`
2. Start MCP server (usually stdio): `notebooklm-mcp`
3. MCP client calls tools:
   - `notebook_create`
   - `source_add (... wait=true)`
   - `notebook_query`
   - `studio_create (... confirm=true)`
   - `studio_status` (poll until complete)
   - `download_artifact`

---

## 6) TypeScript example (stdio client)

Below is a TypeScript example that launches `notebooklm-mcp` as a child process and calls its tools via an MCP client SDK.

> **Important uncertainty note:** the exact npm package name / import paths for the MCP TypeScript SDK can vary by ecosystem version. The example assumes a common `@modelcontextprotocol/sdk` layout, but you may need to adjust imports to match your installed SDK. This part is **not guaranteed** by the repository itself.

```ts
// example.ts
// Prereqs:
// 1) Install notebooklm-mcp-cli so `notebooklm-mcp` is in PATH
// 2) Run `nlm login` at least once (cookies/tokens stored locally)
// 3) Node 18+ recommended

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function unwrapToolResult(result: any): any {
  // Some MCP servers return JSON in content[0].text; others return objects.
  if (result && typeof result === "object" && "status" in result) return result;
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return { rawText: text }; }
  }
  return result;
}

async function main() {
  // Start notebooklm-mcp via stdio (default transport)
  const transport = new StdioClientTransport({
    command: "notebooklm-mcp",
    args: [],
    env: process.env,
  });

  const client = new Client(
    { name: "ts-notebooklm-client", version: "0.1.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  // (Optional) list tools
  const toolsList = await client.listTools();
  console.log("Tools:", toolsList.tools.map((t: any) => t.name));

  // 1) Create a notebook
  const createdRaw = await client.callTool({
    name: "notebook_create",
    arguments: { title: "TS MCP Demo Notebook" },
  });
  const created = unwrapToolResult(createdRaw);
  if (created.status !== "success") throw new Error(created.error ?? "notebook_create failed");
  const notebookId = created.notebook_id as string;
  console.log("Created notebook:", created.notebook);

  // 2) Add a URL source and wait until processed
  const addSourceRaw = await client.callTool({
    name: "source_add",
    arguments: {
      notebook_id: notebookId,
      source_type: "url",
      url: "https://example.com",
      wait: true,
      wait_timeout: 120.0,
    },
  });
  const addSource = unwrapToolResult(addSourceRaw);
  if (addSource.status !== "success") throw new Error(addSource.error ?? "source_add failed");
  console.log("Added source:", addSource);

  // 3) Ask NotebookLM about the sources
  const queryRaw = await client.callTool({
    name: "notebook_query",
    arguments: {
      notebook_id: notebookId,
      query: "Summarize the key points from the added source in 5 bullets.",
    },
  });
  const query = unwrapToolResult(queryRaw);
  if (query.status !== "success") throw new Error(query.error ?? "notebook_query failed");
  console.log("Query response:", query);

  // 4) Generate a quiz (studio_create requires confirm=true)
  //    If confirm is omitted/false, the server returns a pending_confirmation preview.
  const previewRaw = await client.callTool({
    name: "studio_create",
    arguments: {
      notebook_id: notebookId,
      artifact_type: "quiz",
      question_count: 5,
      difficulty: "medium",
      // confirm omitted -> preview
    },
  });
  console.log("Preview:", unwrapToolResult(previewRaw));

  // In a real agent, get explicit user approval before setting confirm=true.
  const createQuizRaw = await client.callTool({
    name: "studio_create",
    arguments: {
      notebook_id: notebookId,
      artifact_type: "quiz",
      question_count: 5,
      difficulty: "medium",
      confirm: true,
    },
  });
  console.log("Quiz started:", unwrapToolResult(createQuizRaw));

  // 5) Poll studio_status until generation completes
  for (let i = 0; i < 30; i++) {
    const statusRaw = await client.callTool({
      name: "studio_status",
      arguments: { notebook_id: notebookId },
    });
    const status = unwrapToolResult(statusRaw);
    if (status.status !== "success") throw new Error(status.error ?? "studio_status failed");
    console.log(`Studio status[${i}]`, status.summary);
    if (status.summary?.in_progress === 0) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  // 6) Download the latest quiz as JSON
  const downloadRaw = await client.callTool({
    name: "download_artifact",
    arguments: {
      notebook_id: notebookId,
      artifact_type: "quiz",
      output_path: "./quiz.json",
      output_format: "json",
    },
  });
  const download = unwrapToolResult(downloadRaw);
  if (download.status !== "success") throw new Error(download.error ?? "download_artifact failed");
  console.log("Downloaded to:", download);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

---

## 7) Practical notes for agents (Codex-friendly)

- Prefer the **unified tools**:
  - `source_add` for all source types
  - `studio_create` for all artifacts
  - `download_artifact` for all downloads
  - Reference: `docs/MCP_GUIDE.md`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/docs/MCP_GUIDE.md

- Respect confirmation gates:
  - Destructive operations and artifact creation often require `confirm=true`.
  - `studio_create` intentionally returns a `pending_confirmation` preview when `confirm=false`.  
    Reference: `studio.py`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/studio.py

- If authentication errors occur:
  - Run `nlm login` again (cookies expire/rotate).
  - Reference: `docs/AUTHENTICATION.md`  
    https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/docs/AUTHENTICATION.md

---

## References (primary sources in this repo fork)

- README: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/README.md  
- MCP Guide: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/docs/MCP_GUIDE.md  
- Authentication Guide: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/docs/AUTHENTICATION.md  
- MCP Server entrypoint: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/server.py  
- Tools (examples):
  - Notebooks: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/notebooks.py  
  - Sources: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/sources.py  
  - Chat: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/chat.py  
  - Studio: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/studio.py  
  - Downloads: https://github.com/jaewonE/notebooklm-mcp-cli/blob/main/src/notebooklm_tools/mcp/tools/downloads.py  
