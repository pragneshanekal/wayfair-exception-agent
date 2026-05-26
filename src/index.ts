import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  executeAgentRun,
  getAgentConfig,
  getRun,
  listRecentRuns,
  saveAgentConfig,
} from "./agent/store";
import { TOOL_SCHEMAS } from "./agent/tools";
import type { AgentConfig, Env } from "./types";

export { ExceptionDO } from "./exception-do";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());
app.use("/case*", cors());
app.use("/cases*", cors());

app.get("/api/health", (c) => {
  return c.json({ ok: true, service: "wayfair-exception-agent" });
});

// ── Agent config (existing) ────────────────────────────────────────────────

app.get("/api/agent/config", async (c) => {
  const config = await getAgentConfig(c.env.AGENT_KV);
  return c.json(config);
});

app.put("/api/agent/config", async (c) => {
  const body = (await c.req.json()) as Partial<AgentConfig>;
  const config = await saveAgentConfig(c.env.AGENT_KV, body);
  return c.json(config);
});

app.get("/api/agent/tools", (c) => {
  return c.json({ tools: TOOL_SCHEMAS });
});

app.get("/api/runs", async (c) => {
  const runs = await listRecentRuns(c.env.AGENT_KV);
  return c.json({ runs });
});

app.get("/api/runs/:id", async (c) => {
  const run = await getRun(c.env.AGENT_KV, c.req.param("id"));
  if (!run) return c.json({ error: "Run not found" }, 404);
  return c.json(run);
});

app.post("/api/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    instructions?: string;
    trigger?: "api" | "button";
  };
  const config = await getAgentConfig(c.env.AGENT_KV);
  const instructions = body.instructions ?? config.instructions;
  const run = await executeAgentRun(c.env, body.trigger ?? "api", instructions);
  return c.json(run, run.status === "failed" ? 500 : 200);
});

app.post("/api/webhook", async (c) => {
  const secret = c.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = c.req.header("x-webhook-secret");
    if (provided !== secret) return c.json({ error: "Unauthorized webhook" }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    event?: string;
    instructions?: string;
    payload?: unknown;
  };
  const config = await getAgentConfig(c.env.AGENT_KV);
  const eventName = body.event ?? "webhook";
  const instructions =
    body.instructions ??
    `An external event "${eventName}" was received.\n\nPayload:\n${JSON.stringify(body.payload ?? body, null, 2)}\n\nDecide what action to take and respond with a summary.`;
  const run = await executeAgentRun(c.env, "webhook", instructions);
  return c.json(run, run.status === "failed" ? 500 : 200);
});

// ── Exception cases ────────────────────────────────────────────────────────

function doStub(env: Env, caseId: string): DurableObjectStub {
  return env.EXCEPTION_DO.get(env.EXCEPTION_DO.idFromName(caseId));
}

// GET /cases — list all cases from KV index
app.get("/cases", async (c) => {
  const list = await c.env.CASE_INDEX.list({ prefix: "case:" });
  const cases = await Promise.all(
    list.keys.map(async (k) => {
      const val = await c.env.CASE_INDEX.get(k.name);
      return val ? JSON.parse(val) : null;
    }),
  );
  const sorted = cases
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json({ cases: sorted, count: sorted.length });
});

// POST /case — submit a new exception case
app.post("/case", async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const caseId = (body.id as string | undefined) ?? `case_${Date.now()}`;

  const stub = doStub(c.env, caseId);

  const initRes = await stub.fetch(
    new Request("http://do/init", {
      method: "PUT",
      body: JSON.stringify({ caseId, input: body }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  const initData = await initRes.json() as { already_exists?: boolean; state?: unknown };

  if (initData.already_exists) {
    return c.json({ message: "Case already exists", caseId, state: initData.state });
  }

  // Kick off resolution in background — return 202 immediately
  c.executionCtx.waitUntil(
    stub.fetch(new Request("http://do/resolve", { method: "POST" })),
  );

  return c.json({ caseId, status: "processing" }, 202);
});

// GET /case/:id — get case status + audit trail
app.get("/case/:id", async (c) => {
  const stub = doStub(c.env, c.req.param("id"));
  const res = await stub.fetch(new Request("http://do/status"));
  const data = await res.json();
  return c.json(data, res.status as 200 | 404 | 500);
});

// POST /case/:id/resolve — re-trigger resolution (for failed cases)
app.post("/case/:id/resolve", async (c) => {
  const stub = doStub(c.env, c.req.param("id"));
  const res = await stub.fetch(new Request("http://do/resolve", { method: "POST" }));
  const data = await res.json();
  return c.json(data, res.status as 200 | 500);
});

// ── Static assets ──────────────────────────────────────────────────────────

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

async function handleScheduled(env: Env): Promise<void> {
  const config = await getAgentConfig(env.AGENT_KV);
  await executeAgentRun(env, "cron", config.cronInstructions);
}

export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await handleScheduled(env);
  },
};
