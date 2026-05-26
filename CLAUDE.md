# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

Wayfair × Subconscious hackathon — **Track 2: Supply Chain**. The goal is to build an agent that improves Wayfair's supply chain management (shipment exceptions, damage claims, routing decisions, returns disposition, partial PO reconciliation).

## Commands

```bash
npm run dev       # local dev server at http://localhost:8787 (wrangler dev)
npm run deploy    # deploy to Cloudflare Workers
npm run check     # TypeScript type-check (tsc --noEmit), no test runner exists
```

**First-time setup:**
```bash
cp .dev.vars.example .dev.vars   # add SUBCONSCIOUS_API_KEY
npx wrangler kv namespace create AGENT_KV
npx wrangler kv namespace create AGENT_KV --preview
# paste both IDs into wrangler.toml [[kv_namespaces]]
```

## Architecture

The agent is four parts wired together:

```
Trigger (src/index.ts)
  → Harness (src/agent/store.ts → runner.ts → loop.ts)
    → LLM (src/subconscious/client.ts → Subconscious API)
      ↔ Tools (src/agent/tools.ts)
```

**Request flow:**
1. `src/index.ts` — Hono router handles `POST /api/run`, `POST /api/webhook`, cron scheduled events, and config CRUD. All triggers call `executeAgentRun()`.
2. `src/agent/store.ts` — `executeAgentRun()` loads config from KV, creates a run record, then calls `runAgent()` from runner.ts. Persists run history in KV with a 7-day TTL.
3. `src/agent/runner.ts` — thin adapter between the stored `AgentConfig` and `runAgentLoop()`.
4. `src/agent/loop.ts` — the ReAct loop. Builds a system prompt, calls the LLM, parses `{ "action": "tool_call" | "final_answer", ... }` JSON, executes tools, repeats up to `maxSteps` (default 8).
5. `src/agent/tools.ts` — `TOOL_REGISTRY` maps tool names to `{ description, parameters, execute }`. The LLM sees tool descriptions; the Worker executes them.
6. `src/subconscious/client.ts` — OpenAI SDK pointed at `https://api.subconscious.dev/v1`. Uses a custom `fetch` interceptor to inject `chat_template_kwargs: { enable_thinking: false }` on every chat/completions POST (Subconscious defaults thinking ON).

**Key design constraints:**
- Tools are **client-side only** — the Worker executes every tool call, not the LLM provider.
- The LLM must respond with a single JSON object every turn (enforced via `response_format: json_schema`). Never call `/v1/responses` — only `/v1/chat/completions` works.
- Agent config (system prompt, enabled tools, temperature, etc.) lives in KV under key `"agent:config"` and is loaded fresh on each run. Defaults are in `src/types.ts` → `DEFAULT_AGENT_CONFIG`.
- `enabledTools` in config controls which tools from `TOOL_REGISTRY` the LLM can see and call. Tools not in `enabledTools` are invisible to the agent.

## Adding supply chain tools

All hackathon tool work goes in `src/agent/tools.ts`. Copy the `search_catalog` shape:

```typescript
my_tool: {
  name: "my_tool",
  description: "...",
  parameters: {
    type: "object",
    properties: { ... },
    required: [...],
  },
  execute: async (args) => { ... },
},
```

Then add the tool name to `enabledTools` in `DEFAULT_AGENT_CONFIG` (`src/types.ts`) or via `PUT /api/agent/config`.

## Triggers for supply chain use cases

- **Webhook** (`POST /api/webhook` with `{ "event": "shipment.exception", "payload": {...} }`) — best for real-time shipment events
- **Cron** — configured in `wrangler.toml` `[triggers].crons`; instructions come from `config.cronInstructions`
- **API** (`POST /api/run` with `{ "instructions": "..." }`) — on-demand ops queries

## Subconscious API

- Model: `subconscious/tim-qwen3.6-27b`
- `createSubconscious(apiKey, { enableThinking: false })` → call `.chat(model).completions.create(...)`
- Set `enableThinking: true` for harder multi-step reasoning (slower)
