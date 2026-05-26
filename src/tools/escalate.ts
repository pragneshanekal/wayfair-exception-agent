export interface EscalateArgs {
  case_id: string;
  reason: string;
  severity: "low" | "medium" | "high" | "critical";
}

const PRIORITY_MAP: Record<string, string> = {
  critical: "urgent",
  high: "high",
  medium: "default",
  low: "low",
};

const TAG_MAP: Record<string, string> = {
  critical: "rotating_light,warning",
  high: "warning",
  medium: "package",
  low: "information_source",
};

export async function escalate(args: EscalateArgs, opsChannel: string): Promise<Record<string, unknown>> {
  const ticketId = `TKT-${args.case_id.toUpperCase().replace(/[^A-Z0-9]/g, "")}-${Date.now().toString(36).toUpperCase()}`;
  const assignedTeam = args.severity === "critical" ? "ops-oncall" : "logistics-ops";

  await fetch(`https://ntfy.sh/${opsChannel}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Title": `[${args.severity.toUpperCase()}] Exception ${args.case_id}`,
      "Priority": PRIORITY_MAP[args.severity] ?? "default",
      "Tags": TAG_MAP[args.severity] ?? "package",
    },
    body: `Ticket ${ticketId}\nCase: ${args.case_id}\nTeam: ${assignedTeam}\n\n${args.reason}`,
  });

  return {
    status: "escalated",
    ticket_id: ticketId,
    case_id: args.case_id,
    severity: args.severity,
    reason: args.reason,
    assigned_team: assignedTeam,
    sla_response_hours: args.severity === "critical" ? 1 : args.severity === "high" ? 4 : 24,
    message: `Case escalated to ${assignedTeam}. Ticket ${ticketId} created.`,
  };
}
