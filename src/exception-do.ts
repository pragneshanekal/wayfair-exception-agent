import { runAgentLoop } from "./agent/loop";
import type { AuditEntry, CaseState, Env } from "./types";

export type { AuditEntry, CaseState };

export class ExceptionDO implements DurableObject {
  private storage: DurableObjectStorage;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "PUT" && url.pathname === "/init") {
      return this.handleInit(request);
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return this.handleStatus();
    }
    if (request.method === "POST" && url.pathname === "/resolve") {
      return this.handleResolve();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = await request.json() as { caseId: string; input: Record<string, unknown> };
    const existing = await this.storage.get<CaseState>("state");

    if (existing) {
      return Response.json({ already_exists: true, state: existing });
    }

    const state: CaseState = {
      caseId: body.caseId,
      status: "pending",
      retries: 0,
      resolution: null,
      auditTrail: [],
      input: body.input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.storage.put("state", state);
    return Response.json(state, { status: 201 });
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.storage.get<CaseState>("state");
    if (!state) {
      return new Response("Case not found", { status: 404 });
    }
    return Response.json(state);
  }

  private async handleResolve(): Promise<Response> {
    const state = await this.storage.get<CaseState>("state");
    if (!state) {
      return new Response("Case not found", { status: 404 });
    }

    if (state.status === "resolved") {
      return Response.json({ idempotent: true, state });
    }

    if (state.status === "processing") {
      return Response.json({ status: "already_processing", state });
    }

    state.status = "processing";
    state.updatedAt = new Date().toISOString();
    await this.storage.put("state", state);

    try {
      const { resolution, auditTrail, usage } = await runAgentLoop(
        state.input,
        this.env.SUBCONSCIOUS_API_KEY,
        {
          opsChannel: this.env.NTFY_OPS_CHANNEL,
          customerChannel: this.env.NTFY_CUSTOMER_CHANNEL,
        },
      );

      state.status = "resolved";
      state.resolution = resolution;
      state.auditTrail = auditTrail;
      state.usage = usage;
      state.retries += 1;
      state.updatedAt = new Date().toISOString();

      await this.storage.put("state", state);

      // Write full audit to R2
      await this.env.AUDIT_LOG.put(
        `audit/${state.caseId}.json`,
        JSON.stringify({ ...state, resolvedAt: state.updatedAt }, null, 2),
        { httpMetadata: { contentType: "application/json" } },
      );

      // Write summary to KV index
      await this.env.CASE_INDEX.put(
        `case:${state.caseId}`,
        JSON.stringify({
          caseId: state.caseId,
          status: state.status,
          exceptionType: (state.input as { exception_type?: string }).exception_type ?? "unknown",
          resolution: resolution.slice(0, 300),
          severity: (state.input as { severity?: string }).severity ?? "unknown",
          usage,
          updatedAt: state.updatedAt,
          createdAt: state.createdAt,
        }),
      );

      return Response.json(state);
    } catch (err) {
      state.status = "failed";
      state.resolution = `Error: ${err instanceof Error ? err.message : String(err)}`;
      state.retries += 1;
      state.updatedAt = new Date().toISOString();
      await this.storage.put("state", state);
      return Response.json(state, { status: 500 });
    }
  }
}
