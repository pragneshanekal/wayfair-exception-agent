import { contactCarrier, type ContactCarrierArgs } from "./contact-carrier";
import { escalate, type EscalateArgs } from "./escalate";
import { fileClaim, type FileClaimArgs } from "./file-claim";
import { notifyCustomer, type NotifyCustomerArgs } from "./notify-customer";
import { refund, type RefundArgs } from "./refund";
import { reschedule, type RescheduleArgs } from "./reschedule";
import { voidLabel, type VoidLabelArgs } from "./void-label";

export interface ToolEnv {
  opsChannel: string;
  customerChannel: string;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  env: ToolEnv,
): Promise<Record<string, unknown>> {
  const a = args as unknown;
  switch (name) {
    case "contact_carrier":
      return contactCarrier(a as ContactCarrierArgs);
    case "escalate":
      return escalate(a as EscalateArgs, env.opsChannel);
    case "file_claim":
      return fileClaim(a as FileClaimArgs);
    case "notify_customer":
      return notifyCustomer(a as NotifyCustomerArgs, env.customerChannel);
    case "refund":
      return refund(a as RefundArgs);
    case "reschedule":
      return reschedule(a as RescheduleArgs);
    case "void_label":
      return voidLabel(a as VoidLabelArgs);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
