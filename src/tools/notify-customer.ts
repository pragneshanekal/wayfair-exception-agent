export interface NotifyCustomerArgs {
  customer_email: string;
  order_id: string;
  template: string;
  message: string;
}

const TEMPLATE_TITLES: Record<string, string> = {
  delay_notice: "Update on your Wayfair order",
  address_correction_request: "Action required: confirm your delivery address",
  claim_opened: "We've opened a claim for your order",
  refund_initiated: "Your refund is on the way",
  replacement_shipped: "Your replacement order has shipped",
  outage_suppression: "We're looking into your shipment",
};

export async function notifyCustomer(args: NotifyCustomerArgs, customerChannel: string): Promise<Record<string, unknown>> {
  const notificationId = `NOTIF-${args.order_id.replace(/[^A-Z0-9]/gi, "").toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  const title = TEMPLATE_TITLES[args.template] ?? `Update on order ${args.order_id}`;

  await fetch(`https://ntfy.sh/${customerChannel}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Title": title,
      "Tags": "package,email",
    },
    body: `To: ${args.customer_email}\nOrder: ${args.order_id}\n\n${args.message}`,
  });

  return {
    status: "notification_sent",
    notification_id: notificationId,
    customer_email: args.customer_email,
    order_id: args.order_id,
    template: args.template,
    sent_at: new Date().toISOString(),
    message: `Customer notified via ${args.template} template.`,
  };
}
