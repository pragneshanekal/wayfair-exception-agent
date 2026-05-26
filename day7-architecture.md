---
project: Hackathon 2026-05-26
type: architecture
status: reference
tags: [hackathon, track-2, supply-chain, cloudflare, durable-objects, day7]
created: 2026-05-25
source: /Users/pragneshanekal/Documents/Local/GitHub/BostonTechWeek/day7/ARCHITECTURE.md
related: [[CLAUDE-track2-supply-chain]]
---

# Day 7 — Logistics Exception Agent: Architecture

Built on **Cloudflare Workers + Durable Objects**. Each shipment exception case gets its own isolated Durable Object that holds all state, runs the LLM reasoning loop, writes an audit trail to R2, and publishes a summary to KV.

---

## System Overview

```mermaid
flowchart TD
    Browser["Browser / Dashboard\n(src/dashboard.ts)"]
    Worker["worker.ts\nHTTP Router"]
    DO["ExceptionDO\nexception-do.ts\n(one per case)"]
    Loop["Agent Loop\nagent/loop.ts"]
    Tools["Tool Executor\ntools/index.ts"]
    Subconscious["Subconscious LLM API\n(PRIMARY)"]
    BaseTen["Baseten Frontier Gateway\n(alternative / comparison)"]
    KV["Cloudflare KV\nCASE_INDEX"]
    R2["Cloudflare R2\nAUDIT_LOG"]
    Ntfy_Ops["ntfy.sh\nbtw25-logistics-ops"]
    Ntfy_Cust["ntfy.sh\nbtw25-logistics-customer"]

    Browser -->|"POST /case\nGET /case/:id\nGET /cases\nDELETE /cases\nGET /dashboard"| Worker
    Worker -->|"PUT /init\nGET /status\nPOST /resolve"| DO
    Worker -->|"202 immediately\nctx.waitUntil()"| DO
    DO -->|"runAgentLoop()"| Loop
    Loop -->|"POST /v1/chat/completions"| Subconscious
    Subconscious -->|"fails → fallback"| BaseTen
    Loop -->|"executeTool(name, args)"| Tools
    Tools -->|"POST"| Ntfy_Ops
    Tools -->|"POST"| Ntfy_Cust
    DO -->|"put audit/caseId.json"| R2
    DO -->|"put case:caseId"| KV
    KV -->|"GET /cases"| Worker
    Worker -->|"case cards + stats"| Browser
```

---

## Request Lifecycle (step by step)

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as worker.ts
    participant DO as ExceptionDO
    participant L as agent/loop.ts
    participant LLM as Subconscious LLM
    participant T as tools/index.ts
    participant KV as KV (CASE_INDEX)
    participant R2 as R2 (AUDIT_LOG)

    B->>W: POST /case {case JSON}
    W->>DO: PUT /init → creates state (status=pending)
    DO-->>W: { state }
    W-->>B: 202 Accepted { caseId }
    Note over W,DO: ctx.waitUntil() fires in background

    W->>DO: POST /resolve (background)
    DO->>DO: status = "processing"
    DO->>L: runAgentLoop(caseInput, env)

    loop Up to 8 iterations
        L->>LLM: POST /v1/chat/completions (tools=[7 schemas])
        LLM-->>L: finish_reason="tool_calls" → tool name + args
        L->>T: executeTool(name, args)
        T-->>L: mock result JSON
        L->>L: append to auditTrail, add tool_result to messages
        LLM-->>L: finish_reason="stop" → resolution text
    end

    L-->>DO: { resolution, auditTrail }
    DO->>DO: status = "resolved"
    DO->>R2: put audit/{caseId}.json (full audit)
    DO->>KV: put case:{caseId} (summary)

    B->>W: GET /case/:id (polling every 2s)
    W->>DO: GET /status
    DO-->>W: CaseState
    W-->>B: { status, resolution, auditTrail }
    B->>B: render card + tool timeline
```

---

## File Map

```
day7/
├── src/
│   ├── worker.ts           ← HTTP router — entry point for all requests
│   ├── exception-do.ts     ← ExceptionDO class — one instance per case
│   ├── dashboard.ts        ← Returns full HTML for GET /dashboard
│   ├── agent/
│   │   ├── loop.ts         ← LLM reasoning loop (fetch-based, no SDK)
│   │   └── tools.ts        ← 7 OpenAI-format tool schemas (sent to LLM)
│   └── tools/
│       ├── index.ts        ← executeTool() dispatcher
│       ├── contact-carrier.ts   → mock: returns carrier inquiry result
│       ├── escalate.ts          → REAL: fires ntfy.sh/btw25-logistics-ops
│       ├── file-claim.ts        → mock: returns claim ID
│       ├── notify-customer.ts   → REAL: fires ntfy.sh/btw25-logistics-customer
│       ├── refund.ts            → mock: returns refund ID
│       ├── reschedule.ts        → mock: returns new tracking number
│       └── void-label.ts        → mock: returns void confirmation
├── eval/
│   ├── cases.json          ← 8 test exception cases
│   └── run.js              ← Node script to POST all 8 cases at once
└── wrangler.jsonc          ← Cloudflare config (DO, KV, R2 bindings)
```

---

## Component Responsibilities

| File | What it owns |
|------|-------------|
| `worker.ts` | HTTP routing, stub creation, `ctx.waitUntil()` for async resolve |
| `exception-do.ts` | Per-case state machine (`pending → processing → resolved/failed`), R2 write, KV write |
| `agent/loop.ts` | LLM conversation loop, Subconscious → Baseten Frontier Gateway fallback, auditTrail accumulation |
| `agent/tools.ts` | OpenAI function-calling schemas — tells the LLM what tools exist |
| `tools/index.ts` | `executeTool()` switch — dispatches string tool names to typed implementations |
| `tools/escalate.ts` | Generates ticket ID, POSTs to ntfy.sh with priority/tag mapping |
| `tools/notify-customer.ts` | POSTs customer notification to ntfy.sh |
| `tools/*.ts` (others) | Deterministic mock responses (same args → same result) |
| `dashboard.ts` | Self-contained HTML/CSS/JS — polls `/case/:id` every 2s, renders cards |

---

## Exception Types → Tool Sequences

| Exception | Tools Called |
|-----------|-------------|
| `delayed_shipment` | `contact_carrier` → `notify_customer` |
| `address_not_found` | `notify_customer` → `escalate` (if >1 attempt) |
| `delivery_dispute` | `file_claim` → `escalate` |
| `customs_hold` | `escalate` (customs broker) → `notify_customer` |
| `damaged_package` | `file_claim` → `refund` or `reschedule` |
| `carrier_api_failure` | `escalate` (ops, critical) — no customer notification |
| `return_not_received` | `contact_carrier` → `escalate` |
| `duplicate_shipment` | `void_label` → confirms primary shipment |

---

## State Machine (per Durable Object)

```mermaid
stateDiagram-v2
    [*] --> pending : PUT /init
    pending --> processing : POST /resolve
    processing --> resolved : runAgentLoop() succeeds
    processing --> failed : runAgentLoop() throws
    resolved --> resolved : POST /resolve (idempotent — no-op)
```

---

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `EXCEPTION_DO` | Durable Object | One DO instance per `caseId` — holds SQLite state |
| `CASE_INDEX` | KV Namespace | Stores resolved case summaries, queried by `GET /cases` |
| `AUDIT_LOG` | R2 Bucket | Stores full audit JSON at `audit/{caseId}.json` |
| `SUBCONSCIOUS_API_KEY` | Secret | **Primary** LLM provider (per sponsor stack) |
| `SUBCONSCIOUS_BASE_URL` | Env var | Subconscious API endpoint |
| `BASETEN_GATEWAY_URL` | Env var | Baseten **Frontier Gateway** endpoint |
| `BASETEN_API_KEY` | Secret | Fallback LLM provider via Frontier Gateway |
| `BASETEN_MODEL` | Env var | Model routed through Frontier Gateway (e.g. `deepseek-ai/DeepSeek-V3.1`) |

---

## Real External Integrations

```mermaid
flowchart LR
    escalate["tools/escalate.ts"] -->|"POST ntfy.sh/btw25-logistics-ops\nPriority: urgent/high/default/low\nTags: rotating_light, warning..."| OpsPhone["Ops phone/browser\nreal-time alert"]

    notify["tools/notify-customer.ts"] -->|"POST ntfy.sh/btw25-logistics-customer\nTags: package, email"| CustPhone["Customer phone/browser\nreal-time alert"]
```

Both integrations fire real HTTP requests to `ntfy.sh` — no signup required, works in any browser or the ntfy mobile app.
