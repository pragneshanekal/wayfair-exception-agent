import { SUBCONSCIOUS_BASE_URL, SUBCONSCIOUS_MODEL } from "../subconscious/client";
import { getToolsForCaseType } from "./tools";
import { executeTool, type ToolEnv } from "../tools/index";
import type { AuditEntry, TokenUsage } from "../types";

// Static prompt — never interpolated, maximises prefix cache hits across cases of the same type.
const SYSTEM_PROMPT = `You are a Wayfair logistics exception-resolution agent. Given a shipment exception case, analyze it and call the appropriate tools to resolve it. Call multiple tools if needed. After all tool calls complete, provide a concise summary of what was done and the resolution status.

Exception type guidance:
- delayed_shipment        → contact_carrier (get status update), then notify_customer (delay_notice)
- address_not_found       → notify_customer (address_correction_request); escalate if >1 delivery attempt
- delivery_dispute        → file_claim (dispute or loss), then escalate (investigation)
- customs_hold            → escalate (customs broker), then notify_customer (delay_notice)
- damaged_package         → file_claim (damage, attach evidence_urls if present), then reschedule or refund based on order value
- carrier_api_failure     → escalate (ops, critical severity); do NOT notify customers during outage
- return_not_received     → contact_carrier, then escalate; do not issue refund yet
- duplicate_shipment      → void_label for the duplicate tracking number; confirm primary shipment

Always use the exact IDs, emails, and tracking numbers from the case input.`;

// Complex cases benefit from deeper reasoning; simple ones are faster without it.
const THINKING_CASE_TYPES = new Set(["delivery_dispute", "customs_hold", "damaged_package"]);

// Cap tokens per case type — simple cases need far fewer output tokens.
const MAX_TOKENS_BY_TYPE: Record<string, number> = {
  delayed_shipment:    600,
  address_not_found:   500,
  delivery_dispute:    900,
  customs_hold:        800,
  damaged_package:     900,
  carrier_api_failure: 500,
  return_not_received: 700,
  duplicate_shipment:  400,
};

export type { TokenUsage };

export interface RunLoopResult {
  resolution: string;
  auditTrail: AuditEntry[];
  usage: TokenUsage;
}

export async function runAgentLoop(
  caseInput: Record<string, unknown>,
  apiKey: string,
  toolEnv: ToolEnv,
  _maxTokensOverride?: number,
  maxIter = 8,
): Promise<RunLoopResult> {
  const auditTrail: AuditEntry[] = [];
  const caseType = String(caseInput.exception_type ?? "");
  const tools = getToolsForCaseType(caseType);
  const enableThinking = THINKING_CASE_TYPES.has(caseType);
  const maxTokens = _maxTokensOverride ?? MAX_TOKENS_BY_TYPE[caseType] ?? 800;

  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, iterations: 0 };

  const messages: Record<string, unknown>[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Resolve this exception case:\n\n${JSON.stringify(caseInput, null, 2)}` },
  ];

  let resolution = "Unable to resolve within iteration limit.";

  for (let i = 0; i < maxIter; i++) {
    usage.iterations++;

    const res = await fetch(`${SUBCONSCIOUS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SUBCONSCIOUS_MODEL,
        max_tokens: maxTokens,
        messages,
        tools,
        tool_choice: "auto",
        chat_template_kwargs: { enable_thinking: enableThinking, enable_auto_compaction: false },
      }),
    });

    if (!res.ok) {
      resolution = `LLM API error: ${res.status} ${res.statusText}`;
      break;
    }

    const data = await res.json() as {
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      choices: Array<{
        finish_reason: string;
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    // Accumulate token usage across all iterations
    if (data.usage) {
      usage.promptTokens     += data.usage.prompt_tokens;
      usage.completionTokens += data.usage.completion_tokens;
      usage.totalTokens      += data.usage.total_tokens;
    }

    const choice = data.choices[0];
    const msg = choice.message;

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

    if (choice.finish_reason === "stop" || choice.finish_reason === "end_turn") {
      resolution = msg.content ?? "Resolution complete.";
      auditTrail.push({ timestamp: new Date().toISOString(), type: "llm_response", text: resolution });
      break;
    }

    if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
      const toolResults: Record<string, unknown>[] = [];

      for (const tc of msg.tool_calls) {
        const toolName = tc.function.name;
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          toolArgs = {};
        }

        auditTrail.push({
          timestamp: new Date().toISOString(),
          type: "tool_call",
          tool: toolName,
          args: toolArgs,
        });

        const result = await executeTool(toolName, toolArgs, toolEnv);

        auditTrail.push({
          timestamp: new Date().toISOString(),
          type: "tool_result",
          tool: toolName,
          result,
        });

        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }

      messages.push(...toolResults);
      continue;
    }

    resolution = msg.content ?? "Stopped unexpectedly.";
    break;
  }

  return { resolution, auditTrail, usage };
}
