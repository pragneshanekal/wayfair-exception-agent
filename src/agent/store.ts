import {
  CONFIG_KEY,
  DEFAULT_AGENT_CONFIG,
  RUNS_PREFIX,
  type AgentConfig,
  type AgentRunRecord,
  type Env,
} from "../types";

export async function getAgentConfig(kv: KVNamespace): Promise<AgentConfig> {
  const stored = await kv.get(CONFIG_KEY, "json");
  if (!stored) {
    return DEFAULT_AGENT_CONFIG;
  }
  return { ...DEFAULT_AGENT_CONFIG, ...(stored as Partial<AgentConfig>) };
}

export async function saveAgentConfig(
  kv: KVNamespace,
  config: Partial<AgentConfig>,
): Promise<AgentConfig> {
  const current = await getAgentConfig(kv);
  const merged = { ...current, ...config };
  await kv.put(CONFIG_KEY, JSON.stringify(merged));
  return merged;
}

export async function saveRun(
  kv: KVNamespace,
  run: AgentRunRecord,
): Promise<void> {
  await kv.put(`${RUNS_PREFIX}${run.id}`, JSON.stringify(run), {
    expirationTtl: 60 * 60 * 24 * 7, // keep runs for 7 days
  });
}

export async function getRun(
  kv: KVNamespace,
  id: string,
): Promise<AgentRunRecord | null> {
  const record = await kv.get(`${RUNS_PREFIX}${id}`, "json");
  return (record as AgentRunRecord | null) ?? null;
}

export async function listRecentRuns(
  kv: KVNamespace,
  limit = 20,
): Promise<AgentRunRecord[]> {
  const list = await kv.list({ prefix: RUNS_PREFIX, limit: 100 });
  const runs: AgentRunRecord[] = [];

  for (const key of list.keys) {
    const record = await kv.get(key.name, "json");
    if (record) {
      runs.push(record as AgentRunRecord);
    }
  }

  return runs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function createRunId(): string {
  return crypto.randomUUID();
}

export async function executeAgentRun(
  env: Env,
  trigger: AgentRunRecord["trigger"],
  instructions: string,
): Promise<AgentRunRecord> {
  const config = await getAgentConfig(env.AGENT_KV);
  const run: AgentRunRecord = {
    id: createRunId(),
    trigger,
    status: "running",
    input: instructions,
    createdAt: new Date().toISOString(),
  };

  await saveRun(env.AGENT_KV, run);

  try {
    const { runAgent } = await import("./runner");
    const result = await runAgent({
      config,
      instructions,
      apiKey: env.SUBCONSCIOUS_API_KEY,
      opsChannel: env.NTFY_OPS_CHANNEL,
      customerChannel: env.NTFY_CUSTOMER_CHANNEL,
    });

    run.status = "completed";
    run.output = result.answer;
    run.completedAt = new Date().toISOString();
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : "Unknown error";
    run.completedAt = new Date().toISOString();
  }

  await saveRun(env.AGENT_KV, run);
  return run;
}
