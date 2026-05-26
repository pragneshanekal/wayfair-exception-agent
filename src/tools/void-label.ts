export interface VoidLabelArgs {
  tracking_number: string;
  carrier: string;
  order_id: string;
}

export function voidLabel(args: VoidLabelArgs) {
  return {
    status: "label_voided",
    tracking_number: args.tracking_number,
    carrier: args.carrier,
    order_id: args.order_id,
    voided_at: new Date().toISOString(),
    message: `Shipping label ${args.tracking_number} voided with ${args.carrier}. No charges will be incurred.`,
  };
}
