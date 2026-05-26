export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "contact_carrier",
      description: "Request a status update from the carrier for a shipment. Use for delayed, missing, or stalled packages.",
      parameters: {
        type: "object",
        properties: {
          tracking_number: { type: "string", description: "The shipment tracking number" },
          carrier: { type: "string", description: "Carrier name (e.g. UPS, FedEx, USPS, DHL)" },
          order_id: { type: "string", description: "The order ID associated with the shipment" },
        },
        required: ["tracking_number", "carrier", "order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notify_customer",
      description: "Send an email notification to the customer using a named template.",
      parameters: {
        type: "object",
        properties: {
          customer_email: { type: "string", description: "Customer email address" },
          order_id: { type: "string", description: "The order ID" },
          template: {
            type: "string",
            description: "Template name: delay_notice | address_correction_request | claim_opened | refund_initiated | replacement_shipped | outage_suppression",
          },
          message: { type: "string", description: "Plain-text body of the notification" },
        },
        required: ["customer_email", "order_id", "template", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate",
      description: "Open an ops ticket to escalate a case for manual review. Use when automated resolution is insufficient.",
      parameters: {
        type: "object",
        properties: {
          case_id: { type: "string", description: "The case or shipment ID" },
          reason: { type: "string", description: "Clear reason for escalation" },
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
            description: "Escalation severity level",
          },
        },
        required: ["case_id", "reason", "severity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_claim",
      description: "File a carrier claim for damage, loss, dispute, or missing packages.",
      parameters: {
        type: "object",
        properties: {
          tracking_number: { type: "string", description: "The shipment tracking number" },
          carrier: { type: "string", description: "Carrier name" },
          claim_type: {
            type: "string",
            enum: ["damage", "loss", "missing", "dispute"],
            description: "Type of carrier claim",
          },
          order_id: { type: "string", description: "The order ID" },
          evidence_urls: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of photo/document URLs to attach to the claim",
          },
        },
        required: ["tracking_number", "carrier", "claim_type", "order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refund",
      description: "Issue a full or partial refund for an order.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The order ID to refund" },
          amount_usd: { type: "number", description: "Refund amount in USD" },
          reason: { type: "string", description: "Reason for the refund" },
        },
        required: ["order_id", "amount_usd", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule",
      description: "Reschedule or reroute a shipment (e.g. replacement after damage or loss).",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The order ID" },
          tracking_number: { type: "string", description: "The original tracking number" },
          reason: { type: "string", description: "Reason for rescheduling" },
        },
        required: ["order_id", "tracking_number", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "void_label",
      description: "Void a duplicate or erroneous shipping label.",
      parameters: {
        type: "object",
        properties: {
          tracking_number: { type: "string", description: "The tracking number of the label to void" },
          carrier: { type: "string", description: "Carrier name" },
          order_id: { type: "string", description: "The order ID" },
        },
        required: ["tracking_number", "carrier", "order_id"],
      },
    },
  },
] as const;

// Tools available per exception type — keeps context window lean
export const CASE_TYPE_TOOLS: Record<string, string[]> = {
  delayed_shipment:   ["contact_carrier", "notify_customer", "escalate"],
  address_not_found:  ["notify_customer", "escalate", "reschedule"],
  delivery_dispute:   ["file_claim", "escalate", "notify_customer"],
  customs_hold:       ["escalate", "notify_customer"],
  damaged_package:    ["file_claim", "refund", "reschedule", "notify_customer"],
  carrier_api_failure:["escalate"],
  return_not_received:["contact_carrier", "escalate", "notify_customer"],
  duplicate_shipment: ["void_label", "notify_customer"],
};

export function getToolsForCaseType(caseType: string) {
  const allowed = new Set(CASE_TYPE_TOOLS[caseType] ?? TOOL_SCHEMAS.map((t) => t.function.name));
  return TOOL_SCHEMAS.filter((t) => allowed.has(t.function.name));
}
