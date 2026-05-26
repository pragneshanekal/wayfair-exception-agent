export interface AgentConfig {
  name: string;
  systemPrompt: string;
  instructions: string;
  enableThinking: boolean;
  maxTokens: number;
  temperature: number;
  enabledTools: string[];
  cronInstructions: string;
}

export interface AgentRunRecord {
  id: string;
  trigger: "cron" | "api" | "button" | "webhook";
  status: "running" | "completed" | "failed";
  input: string;
  output?: string;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  createdAt: string;
  completedAt?: string;
}

export interface Env {
  SUBCONSCIOUS_API_KEY: string;
  WEBHOOK_SECRET?: string;
  AGENT_KV: KVNamespace;
  CASE_INDEX: KVNamespace;
  EXCEPTION_DO: DurableObjectNamespace;
  AUDIT_LOG: R2Bucket;
  ASSETS: Fetcher;
  NTFY_OPS_CHANNEL: string;
  NTFY_CUSTOMER_CHANNEL: string;
}

export interface AuditEntry {
  timestamp: string;
  type: "tool_call" | "tool_result" | "llm_response";
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  text?: string;
}

export interface CaseState {
  caseId: string;
  status: "pending" | "processing" | "resolved" | "failed";
  retries: number;
  resolution: string | null;
  auditTrail: AuditEntry[];
  input: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const CONFIG_KEY = "agent:config";
export const RUNS_PREFIX = "agent:run:";

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  name: "Hackathon Agent",
  systemPrompt:
    "You are a helpful AI agent running on Cloudflare Workers. Be concise and actionable.",
  instructions:
    "Check in on the hackathon project. Summarize what you would do next and one concrete action the team should take.",
  enableThinking: false,
  maxTokens: 1000,
  temperature: 0.7,
  enabledTools: ["search_catalog", "log_note", "get_time"],
  cronInstructions:
    "This is a scheduled check-in. Review the latest notes and suggest the top priority for the team.",
};
