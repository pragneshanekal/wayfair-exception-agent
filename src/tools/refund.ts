export interface RefundArgs {
  order_id: string;
  amount_usd: number;
  reason: string;
}

export function refund(args: RefundArgs) {
  const refundId = `REF-${args.order_id.replace(/[^A-Z0-9]/gi, "").toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  return {
    status: "refund_initiated",
    refund_id: refundId,
    order_id: args.order_id,
    amount_usd: args.amount_usd,
    reason: args.reason,
    estimated_credit_days: 3,
    message: `Refund of $${args.amount_usd.toFixed(2)} initiated for order ${args.order_id}. Credits appear within 3–5 business days.`,
  };
}
