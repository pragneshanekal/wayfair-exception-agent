import { runAgentLoop } from "./loop";
import type { AgentConfig } from "../types";

export interface RunAgentInput {
  config: AgentConfig;
  instructions: string;
  apiKey: string;
  opsChannel?: string;
  customerChannel?: string;
}

export interface RunAgentResult {
  answer: string;
  toolCalls: Array<{ name: string; arguments: string; result: string }>;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const result = await runAgentLoop(
    { instructions: input.instructions, source: "api" },
    input.apiKey,
    {
      opsChannel: input.opsChannel ?? "wayfair-logistics-ops",
      customerChannel: input.customerChannel ?? "wayfair-logistics-customer",
    },
    input.config.maxTokens,
  );

  const toolCalls = result.auditTrail
    .filter((e) => e.type === "tool_call")
    .map((e) => ({
      name: e.tool ?? "",
      arguments: JSON.stringify(e.args ?? {}),
      result: JSON.stringify(
        result.auditTrail.find(
          (r) => r.type === "tool_result" && r.tool === e.tool,
        )?.result ?? {},
      ),
    }));

  return { answer: result.resolution, toolCalls };
}
