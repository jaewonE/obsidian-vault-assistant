# Link + MCP Guide for NotebookLM (`nlm` + MCP, TypeScript-first)

This guide was validated locally in this repository on **2026-03-01** using your requested inputs:

- `notebook_id`: `37ee94ea-d7d8-4c0c-831e-31ee0153e4cd`
- web link: `https://codingtoday.tistory.com/104`
- YouTube link: `https://www.youtube.com/watch?v=_yumjhDbDWk`

## Quick answers to your 4 questions

1. **Yes**, you can add a link source and then retrieve it.
- Add with MCP tool: `source_add`
- Retrieve source content/details with MCP tool: `source_get_content`
- Retrieve AI summary with MCP tool: `source_describe`
- CLI equivalents: `nlm source add`, `nlm source get <source_id>`, `nlm source describe <source_id>`

2. **Yes**, YouTube links are handled the same flow.
- MCP: still `source_add` with `source_type: "url"`
- CLI: either `--youtube` or `--url`

3. You can extract metadata from add/get/describe responses (details below).

4. `describe` is **not English-only**.
- Default behavior was English in my session.
- Setting `NOTEBOOKLM_HL=ko` returned Korean summaries and keywords for both web and YouTube sources.

---

## 0) Prerequisites

```bash
nlm login --check
```

If authenticated, you can run CLI and MCP flows directly.

---

## 1) Regular web link: add -> get -> describe

## CLI (verified)

```bash
# Add and wait until ready
nlm source add 37ee94ea-d7d8-4c0c-831e-31ee0153e4cd \
  --url "https://codingtoday.tistory.com/104" \
  --wait
```

Observed result:

- `source_id`: `e6d7243d-cf0e-4f67-a5a0-7c7f6bf49001`
- title: `제 57회 SQL 개발자(SQLD) ... — 오늘도 코딩`

```bash
# Get indexed source payload
nlm source get e6d7243d-cf0e-4f67-a5a0-7c7f6bf49001 --json

# Get AI summary + keywords
nlm source describe e6d7243d-cf0e-4f67-a5a0-7c7f6bf49001 --json
```

Observed `source get` metadata:

- `source_type`: `web_page`
- `url`: `https://codingtoday.tistory.com/104`
- `char_count`: `7878`

---

## MCP from TypeScript (recommended for your workflow)

The MCP tool names you need are:

- `source_add`
- `source_get_content` (MCP equivalent of source retrieval)
- `source_describe`

Example TypeScript pattern:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Json = Record<string, unknown>;

const transport = new StdioClientTransport({
  command: "notebooklm-mcp",
  args: [],
  // For Korean describe output by default, uncomment:
  // env: { ...process.env, NOTEBOOKLM_HL: "ko" },
});

const client = new Client({ name: "nlm-ts-client", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

async function callTool<T = Json>(name: string, args: Json): Promise<T> {
  const result: any = await client.callTool({ name, arguments: args });

  // Different MCP clients expose structured results slightly differently.
  if (result?.structuredContent) return result.structuredContent as T;

  const text = result?.content?.find((c: any) => c.type === "text")?.text;
  if (text) return JSON.parse(text) as T;

  return result as T;
}

const notebookId = "37ee94ea-d7d8-4c0c-831e-31ee0153e4cd";
const url = "https://codingtoday.tistory.com/104";

const added = await callTool<{
  status: string;
  ready: boolean;
  source_type: string;
  source_id: string;
  title: string;
}>("source_add", {
  notebook_id: notebookId,
  source_type: "url",
  url,
  wait: true,
});

const sourceId = added.source_id;

const content = await callTool("source_get_content", { source_id: sourceId });
const summary = await callTool("source_describe", { source_id: sourceId });

console.log({ added, content, summary });
```

Verified MCP add result (this run):

- `source_id`: `e6c3e003-14dd-4d41-aad7-d2d50b7eb039`

---

## 2) YouTube link: same flow

## CLI (verified)

```bash
# Add YouTube and wait
nlm source add 37ee94ea-d7d8-4c0c-831e-31ee0153e4cd \
  --youtube "https://www.youtube.com/watch?v=_yumjhDbDWk" \
  --wait

# (Equivalent)
nlm source add 37ee94ea-d7d8-4c0c-831e-31ee0153e4cd \
  --url "https://www.youtube.com/watch?v=_yumjhDbDWk" \
  --wait
```

Observed result:

- `source_id`: `4298bab3-c93d-490e-97c0-abf32052c1b8`
- title: `생각의 외주화`

```bash
nlm source get 4298bab3-c93d-490e-97c0-abf32052c1b8 --json
nlm source describe 4298bab3-c93d-490e-97c0-abf32052c1b8 --json
```

Observed `source get` metadata:

- `source_type`: `youtube`
- `url`: `null` (transcript source)
- `char_count`: `12370`

## MCP (same as regular URL)

```ts
const ytAdded = await callTool("source_add", {
  notebook_id: notebookId,
  source_type: "url",
  url: "https://www.youtube.com/watch?v=_yumjhDbDWk",
  wait: true,
});

const ytContent = await callTool("source_get_content", {
  source_id: ytAdded.source_id,
});

const ytDescribe = await callTool("source_describe", {
  source_id: ytAdded.source_id,
});
```

Verified MCP add result (this run):

- `source_id`: `7cc3412a-0c6d-4e5d-8b0e-9b5dff5f0dca`

---

## 3) What metadata is extractable?

## From `source_add`

Typical fields:

- `status` (`success` or `error`)
- `ready` (`true` if `wait=true` and processing finished)
- `source_type` (logical input type: `url`, `text`, `drive`, `file`)
- `source_id`
- `title`

## From `source_get` (CLI)

Observed fields:

- `content` (full indexed text)
- `title`
- `source_type` (e.g., `web_page`, `youtube`)
- `url` (web source URL; YouTube may be `null`)
- `char_count`

## From `source_get_content` (MCP)

Documented/observed fields:

- `status`
- `content`
- `title`
- `source_type`
- `url`
- `char_count`

Note from this repository version: MCP `source_get_content` currently returned `source_type: "unknown"` in my run, while CLI `source get` returned the correct type (`web_page`/`youtube`).

## From `source_describe`

Fields:

- `summary` (AI-generated)
- `keywords` (array)
- MCP wrapper also returns `status`

---

## 4) Is `describe` English-only? (Korean support)

It is **not** English-only.

Default in my session produced English summaries. Korean output worked when `NOTEBOOKLM_HL=ko`.

CLI examples:

```bash
# English/default (depends on env/profile)
nlm source describe e6d7243d-cf0e-4f67-a5a0-7c7f6bf49001 --json

# Korean
NOTEBOOKLM_HL=ko nlm source describe e6d7243d-cf0e-4f67-a5a0-7c7f6bf49001 --json
NOTEBOOKLM_HL=ko nlm source describe 4298bab3-c93d-490e-97c0-abf32052c1b8 --json
```

MCP/TypeScript: set env when launching `notebooklm-mcp`:

```ts
const transport = new StdioClientTransport({
  command: "notebooklm-mcp",
  env: { ...process.env, NOTEBOOKLM_HL: "ko" },
});
```

---

## Practical recommendation for TypeScript + MCP

1. Always call `source_add` with `wait: true`.
2. Parse and store returned `source_id` immediately.
3. Use `source_get_content` for raw indexed text export.
4. Use `source_describe` for quick AI summary/keyword indexing.
5. If you need Korean summaries consistently, set `NOTEBOOKLM_HL=ko` in the MCP server environment.
