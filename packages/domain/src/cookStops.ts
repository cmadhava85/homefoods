/** Group cook delivery cards / cutoff WA: one stop per customer + address + fulfillment. */

export type CookStopOrderLike = {
  id: number;
  customerMobile: string;
  deliveryTargetAddress?: string | null;
  fulfillmentMode?: string | null;
  qty: number;
  status: string;
};

export function cookStopGroupKey(o: CookStopOrderLike): string {
  const mode = (o.fulfillmentMode || "DELIVERY").toUpperCase();
  const addr = (o.deliveryTargetAddress || "").trim().toLowerCase();
  return `${o.customerMobile}|${mode}|${addr}`;
}

export type CookStopGroup<T extends CookStopOrderLike> = {
  key: string;
  orders: T[];
  totalQty: number;
  customerMobile: string;
  deliveryTargetAddress: string;
  fulfillmentMode: string;
};

export function groupCookStops<T extends CookStopOrderLike>(orders: T[]): CookStopGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const o of orders) {
    const key = cookStopGroupKey(o);
    const list = map.get(key);
    if (list) list.push(o);
    else map.set(key, [o]);
  }
  return [...map.entries()].map(([key, groupOrders]) => {
    const first = groupOrders[0];
    return {
      key,
      orders: groupOrders,
      totalQty: groupOrders.reduce((s, o) => s + o.qty, 0),
      customerMobile: first.customerMobile,
      deliveryTargetAddress: first.deliveryTargetAddress || "",
      fulfillmentMode: (first.fulfillmentMode || "DELIVERY").toUpperCase(),
    };
  });
}
