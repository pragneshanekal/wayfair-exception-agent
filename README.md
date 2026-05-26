# Wayfair Delivery Exception Agent

An AI agent running on **Cloudflare Workers + Durable Objects** that autonomously resolves shipment exceptions the moment they occur — contacting carriers, filing damage claims, notifying customers, and escalating to the right team — with zero human intervention.

Built for the **Wayfair × Subconscious Hackathon — Track 2: Supply Chain**.

---

## The problem it solves

When a shipment exception occurs today, a logistics specialist manually:

1. Opens the exception ticket and reads the case details
2. Calls or emails the carrier to get a status update
3. Drafts a customer-facing message explaining the delay or issue
4. Fills out a claim form if goods are damaged or lost
5. Creates an escalation ticket and assigns it to the right internal team
6. Tracks follow-up and updates the case record

Each case takes **15–40 minutes** of specialist time. Resolution paths are inconsistent across teams. Customers wait hours for a first response. The system doesn't scale during volume spikes.

**With this agent:** a webhook fires, the agent reads the case in milliseconds, executes the right sequence of tools, and the exception is resolved — carrier contacted, customer notified, claim filed, escalation sent — all logged with a full audit trail in R2.

---

## Architecture

```
Webhook / POST /case / Cron
         │
         ▼
 Cloudflare Worker (Hono)
    src/index.ts
         │  creates / routes to
         ▼
 ExceptionDO (Durable Object)
    src/exception-do.ts
    ── one DO per case, SQLite-backed state machine ──
    ── status: pending → processing → resolved/failed ──
         │
         ▼
 Agent Loop  (src/agent/loop.ts)
    ── builds system prompt + filtered tool schemas ──
    ── calls Subconscious LLM via /v1/chat/completions ──
    ── executes tool_calls locally in Worker ──
    ── loops until finish_reason: "stop" or 8 iterations ──
         │              ↑↓ tool_calls
         ▼
 Tools  (src/tools/)
    contact_carrier · notify_customer · file_claim
    escalate · void_label · refund · reschedule
         │
         ▼
 Outputs
    ntfy.sh   — live push notifications (ops + customer channels)
    R2        — full audit JSON per case (wayfair-audit-log)
    KV        — case index for the dashboard (CASE_INDEX)
```

**Key design decisions:**

| Decision | Why |
|---|---|
| One Durable Object per case | Idempotent state machine — safe to retry, resume, and query independently |
| Native `tool_calls` (not ReAct JSON) | LLM selects and calls multiple tools per turn; cleaner than parse-the-JSON loops |
| Static system prompt | Never interpolated → identical prefix across all cases of the same type → server-side prefix cache hits on Subconscious |
| Per-case-type tool filtering | LLM only sees 2–4 relevant tools (not all 7) — keeps schemas under the 8192-token context limit |
| Per-case-type `enable_thinking` | `delivery_dispute`, `customs_hold`, `damaged_package` get deep reasoning; simpler cases stay fast |
| Per-case-type `max_tokens` | 400–900 tokens depending on resolution complexity; avoids over-generating on simple cases |
| `ctx.waitUntil()` | Returns 202 immediately; resolution runs async in background |

---

## Exception types handled

| Exception type | Tools called | Thinking |
|---|---|---|
| `delayed_shipment` | contact_carrier → notify_customer | off |
| `address_not_found` | notify_customer → escalate (if >1 attempt) | off |
| `delivery_dispute` | file_claim → escalate | **on** |
| `customs_hold` | escalate (customs broker) → notify_customer | **on** |
| `damaged_package` | file_claim → reschedule or refund (by order value) | **on** |
| `carrier_api_failure` | escalate (critical, ops) — no customer noise | off |
| `return_not_received` | contact_carrier → escalate — hold refund | off |
| `duplicate_shipment` | void_label (duplicate tracking) | off |

---

## How the LLM reasons through a case

1. **System prompt** — static, never interpolated. Describes all 8 exception types and what tools to call for each. Identical across every run of the same type → Subconscious prefix caches the prompt + tool schemas, cutting cost on subsequent calls.

2. **User message** — the raw case JSON (order ID, tracking number, carrier, customer email, severity, etc.).

3. **LLM turn 1** — the model reads the case, picks the right tools, and returns `finish_reason: "tool_calls"` with one or more function calls (e.g., `contact_carrier` + `notify_customer` in parallel).

4. **Tool execution** — the Worker runs each tool locally: real HTTP calls to ntfy.sh, simulated carrier/claim APIs that return realistic structured data.

5. **LLM turn 2** — the model sees the tool results and either calls more tools or returns `finish_reason: "stop"` with a plain-language resolution summary.

6. **Audit trail** — every tool call, its arguments, its result, and the final LLM response are written to the DO state and flushed to R2 as structured JSON.

For complex cases (disputes, customs holds, damage claims), the model runs an internal `<think>` block before deciding — reasoning through claim type, order value thresholds, and escalation severity — before emitting its first tool call.

---

## Live notifications

The agent fires real push notifications via ntfy.sh on every resolution:

| Channel | When |
|---|---|
| `ntfy.sh/wayfair-logistics-ops` | Escalations (critical/high/medium/low) |
| `ntfy.sh/wayfair-logistics-customer` | Customer notifications (delay, correction request, refund) |

Subscribe on [ntfy.sh](https://ntfy.sh) or the ntfy mobile app to see pushes fire in real time during a demo.

---

## Running locally

```bash
npm install
cp .dev.vars.example .dev.vars
# Add SUBCONSCIOUS_API_KEY=sky_... to .dev.vars

npm run dev   # http://localhost:8787
```

Open the dashboard and use the **Demo** tab to submit any of the 8 exception types. The **Pitch** tab has a live-fire panel for demos.

### Submit a case via curl

```bash
curl -X POST http://localhost:8787/case \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-001",
    "exception_type": "delayed_shipment",
    "order_id": "ORD-8821",
    "tracking_number": "1Z999AA10123456784",
    "carrier": "UPS",
    "customer_email": "jane.doe@example.com",
    "order_value_usd": 142.50,
    "severity": "medium"
  }'

# Poll status
curl http://localhost:8787/case/test-001
```

### Run all 8 eval cases

```bash
node eval/run.js
```

---

## Deploying to Cloudflare Workers

```bash
npx wrangler kv namespace create AGENT_KV
npx wrangler kv namespace create AGENT_KV --preview
npx wrangler kv namespace create CASE_INDEX
npx wrangler kv namespace create CASE_INDEX --preview
npx wrangler r2 bucket create wayfair-audit-log

# Paste KV IDs into wrangler.toml, then:
npm run deploy
npx wrangler secret put SUBCONSCIOUS_API_KEY
```

---

## API reference

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/case` | Submit an exception case (returns 202, resolves async) |
| `GET` | `/case/:id` | Get full case state + audit trail |
| `GET` | `/cases` | List all cases from KV index |
| `POST` | `/case/:id/resolve` | Manually re-trigger resolution |
| `POST` | `/api/run` | Run the legacy agent config loop |
| `POST` | `/api/webhook` | Generic webhook trigger |

---

## Project layout

```
src/
  index.ts              Hono router — all HTTP routes + cron handler
  exception-do.ts       Durable Object — state machine per case
  types.ts              Env, CaseState, AuditEntry, TokenUsage interfaces
  agent/
    loop.ts             ReAct loop — LLM calls, tool dispatch, token accounting
    tools.ts            Tool schemas + per-case-type filter map
    runner.ts           Adapter between AgentConfig and runAgentLoop()
    store.ts            KV-backed config + run history
  tools/
    contact-carrier.ts  Carrier status lookup
    notify-customer.ts  Customer push notification (ntfy.sh)
    escalate.ts         Ops escalation (ntfy.sh, ticket creation)
    file-claim.ts       Damage / dispute claim filing
    void-label.ts       Duplicate label voiding
    refund.ts           Refund issuance
    reschedule.ts       Delivery rescheduling
    index.ts            executeTool() dispatcher
  subconscious/
    client.ts           OpenAI SDK pointed at Subconscious API
eval/
  cases.json            8 test cases covering all exception types
  run.js                Batch submitter
public/
  index.html            Demo dashboard (Demo / All Cases / Pitch / Config tabs)
wrangler.toml           Worker config, KV bindings, R2, Durable Objects, cron
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript, edge-deployed) |
| State | Durable Objects with SQLite storage (one per case) |
| Storage | Cloudflare KV (config + case index), R2 (audit logs) |
| LLM | Subconscious API — `subconscious/tim-qwen3.6-27b` |
| Routing | Hono |
| Notifications | ntfy.sh (real HTTP push) |
