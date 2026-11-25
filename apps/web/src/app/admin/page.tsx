"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RequireAuth } from "@/components/RequireAuth";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { adminHref } from "@/lib/adminPath";
import { CateringAdminPanel } from "./CateringAdminPanel";

type Ticket = {
  id: number;
  summary: string;
  status: string;
  orderId: number | null;
  category: string;
  source?: string | null;
  cookId?: string | null;
  slaDueAt?: string | null;
  decision?: string | null;
};

type Cook = {
  id: string;
  kitchenName: string;
  slugHandle: string;
  isActive: boolean;
  onboardingStatus: string;
  mobileNumber?: string;
  payoutBeneficiaryRef?: string | null;
  payoutUpiId?: string | null;
  payoutAccountNote?: string | null;
  fssaiNumber?: string | null;
  pickupLandmark?: string | null;
  pickupEnabled?: boolean;
  deliveryType?: "SELF" | "PARTNER";
  commissionBps?: number | null;
};

type Pricing = {
  platformFeePaise: number;
  cookCommissionBps: number;
  maxPlatformFeePaise: number;
  maxCookCommissionBps: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

type Settlement = {
  id: number;
  businessDate: string;
  cookId: string;
  kitchenName: string;
  cookSlug: string | null;
  cookMobile: string | null;
  payoutUpiId: string | null;
  payoutAccountNote: string | null;
  payoutBeneficiaryRef: string | null;
  grossPaise?: number;
  feesPaise?: number;
  clawbackPaise?: number;
  pendingClawbackPaise?: number;
  netPaise: number;
  orderCount: number;
  status: string;
  gatewayBatchId: string | null;
  manualPaidAt: string | null;
  manualUtr: string | null;
  manualNote: string | null;
  needsManualPay: boolean;
  ageDays?: number;
  overdue?: boolean;
};

type FeatureFlag = {
  key: string;
  label: string;
  description: string | null;
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

type TurnoverCook = {
  cookId: string;
  kitchenName: string;
  slugHandle: string;
  onboardingStatus: string;
  pinCode: string | null;
  payoutBeneficiaryRef: string | null;
  foodGmvPaise: number;
  deliveryPaise: number;
  platformFeePaise: number;
  customerChargePaise: number;
  plates: number;
  orderCount: number;
  deliveredOrderCount: number;
  heldOrderCount: number;
  refundedFoodPaise: number;
  settledNetPaise: number;
  commissionPaise?: number;
  manualPaidPaise: number;
  transferCompletedPaise: number;
};

type TurnoverReport = {
  range: { from: string; to: string; period: string; label: string };
  purpose: string;
  platform: {
    foodGmvPaise: number;
    deliveryPaise: number;
    platformFeePaise: number;
    customerChargePaise: number;
    plates: number;
    orderCount: number;
    refundedFoodPaise: number;
    settledNetPaise: number;
    commissionPaise?: number;
    cookCountWithVolume: number;
  };
  liveCookCount: number;
  cooks: TurnoverCook[];
};

type Tab = "payouts" | "analytics" | "cooks" | "tickets" | "orders" | "features" | "ads" | "parties";

type AdCampaign = {
  id: number;
  type: "KITCHEN_BOOST" | "EXTERNAL";
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ENDED";
  pinCode: string;
  cookId: string | null;
  cookSlug: string | null;
  kitchenName: string | null;
  title: string;
  body: string | null;
  ctaUrl: string | null;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
};

type SupportActivity = {
  source: string;
  id: string;
  at: string;
  orderId: number | null;
  eventName: string;
  channel: string;
  actor: string | null;
  payload: unknown;
};

type SupportOutbox = {
  id: number;
  eventName: string;
  attempts: number;
  lastError: string | null;
  processedAt: string | null;
  createdAt: string;
  status: "pending" | "failed" | "ok";
  publicId: string | null;
  checkoutId: string | null;
  traceId: string | null;
};

type SupportBundle = {
  matchedBy?: string;
  order: {
    publicId: string;
    checkoutId: string | null;
    traceId?: string;
    status: string;
    customerMobile: string;
    payerMobile: string | null;
    mealType: string;
    serviceDate: string;
    itemName: string;
    qty: number;
    totalPaise: number;
    foodDiscountPaise: number;
    gatewayTxnId: string | null;
    channel: string;
    deliveryTargetAddress?: string | null;
    settlementHold: boolean;
  };
  cook: { kitchenName: string; slugHandle: string; mobileNumber: string } | null;
  checkout: {
    checkoutId: string;
    lines: Array<{
      publicId: string;
      status: string;
      serviceDate: string;
      mealType: string;
      itemName: string;
      qty: number;
      totalPaise: number;
    }>;
  } | null;
  payments: Array<{
    id: number;
    kind: string;
    status: string;
    amountPaise: number;
    gatewayTxnId: string | null;
    createdAt: string;
  }>;
  outbox?: SupportOutbox[];
  cloudLogging?: {
    byTraceId: string;
    byPublicId: string;
    byCheckoutId: string | null;
  };
  activity: SupportActivity[];
};
type AnalyticsPeriod = "week" | "month" | "year";

type AdminOrderRow = {
  publicId: string;
  checkoutId: string | null;
  status: string;
  customerMobile: string;
  serviceDate: string;
  mealType: string;
  itemName: string;
  qty: number;
  totalPaise: number;
  kitchenName: string | null;
  cookSlug: string | null;
  settlementHold: boolean;
};

type AdminAttentionRow = AdminOrderRow & { reason: string };

/** "5" / "2.5" from basis points. */
function bpsToPercentText(bps: number) {
  return String(Number((bps / 100).toFixed(2)));
}

/** Percent text → basis points; "" → null; NaN → undefined (invalid). */
function percentTextToBps(text: string): number | null | undefined {
  const v = text.trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

function rupees(paise: number) {
  return `₹${(paise / 100).toFixed(2)}`;
}

function AdminInner() {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("payouts");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [cooks, setCooks] = useState<Cook[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [features, setFeatures] = useState<FeatureFlag[]>([]);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [feeDraft, setFeeDraft] = useState("");
  const [commissionPctDraft, setCommissionPctDraft] = useState("");
  const [cookCommissionDraft, setCookCommissionDraft] = useState<Record<string, string>>({});
  const [adsEnabled, setAdsEnabled] = useState(false);
  const [adCampaigns, setAdCampaigns] = useState<AdCampaign[]>([]);
  const [adForm, setAdForm] = useState({
    type: "EXTERNAL" as "KITCHEN_BOOST" | "EXTERNAL",
    status: "DRAFT" as AdCampaign["status"],
    pinCode: "600119",
    cookId: "",
    title: "",
    body: "",
    ctaUrl: "",
    priority: "0",
  });
  const [turnover, setTurnover] = useState<TurnoverReport | null>(null);
  const [analyticsPeriod, setAnalyticsPeriod] = useState<AnalyticsPeriod>("month");
  const [settleFilter, setSettleFilter] = useState<"open" | "all">("open");
  const [upiDraft, setUpiDraft] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [routeDraft, setRouteDraft] = useState<Record<string, string>>({});
  const [landmarkDraft, setLandmarkDraft] = useState<Record<string, string>>({});
  const [pickupOnDraft, setPickupOnDraft] = useState<Record<string, boolean>>({});
  const [deliveryTypeDraft, setDeliveryTypeDraft] = useState<Record<string, "SELF" | "PARTNER">>({});
  const [utrDraft, setUtrDraft] = useState<Record<number, string>>({});
  const [payNoteDraft, setPayNoteDraft] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [orderLookup, setOrderLookup] = useState("");
  const [supportBundle, setSupportBundle] = useState<SupportBundle | null>(null);
  const [searchMobile, setSearchMobile] = useState("");
  const [searchCook, setSearchCook] = useState("");
  const [searchDate, setSearchDate] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchRows, setSearchRows] = useState<AdminOrderRow[]>([]);
  const [attentionRows, setAttentionRows] = useState<AdminAttentionRow[]>([]);

  const refreshCooks = useCallback(() => {
    return authFetch("/admin/cooks")
      .then((r) => r.json())
      .then((rows: Cook[]) => {
        setCooks(rows);
        const upi: Record<string, string> = {};
        const note: Record<string, string> = {};
        const route: Record<string, string> = {};
        const landmark: Record<string, string> = {};
        const pickupOn: Record<string, boolean> = {};
        const deliveryType: Record<string, "SELF" | "PARTNER"> = {};
        const commission: Record<string, string> = {};
        for (const c of rows) {
          commission[c.id] = c.commissionBps == null ? "" : bpsToPercentText(c.commissionBps);
          upi[c.id] = c.payoutUpiId ?? "";
          note[c.id] = c.payoutAccountNote ?? "";
          route[c.id] = c.payoutBeneficiaryRef ?? "";
          landmark[c.id] = c.pickupLandmark ?? "";
          pickupOn[c.id] = Boolean(c.pickupEnabled);
          deliveryType[c.id] = c.deliveryType === "PARTNER" ? "PARTNER" : "SELF";
        }
        setUpiDraft(upi);
        setNoteDraft(note);
        setRouteDraft(route);
        setLandmarkDraft(landmark);
        setPickupOnDraft(pickupOn);
        setDeliveryTypeDraft(deliveryType);
        setCookCommissionDraft(commission);
      });
  }, []);

  const applyPricing = useCallback((p: Pricing) => {
    setPricing(p);
    setFeeDraft(String(p.platformFeePaise / 100));
    setCommissionPctDraft(bpsToPercentText(p.cookCommissionBps));
  }, []);

  const refreshPricing = useCallback(() => {
    return authFetch("/admin/pricing")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load pricing");
        applyPricing(json as Pricing);
      })
      .catch((e) => setErr((e as Error).message));
  }, [applyPricing]);

  const refreshSettlements = useCallback(() => {
    return authFetch(`/admin/settlements?filter=${settleFilter}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load settlements");
        setSettlements(Array.isArray(json) ? json : []);
      })
      .catch((e) => setErr((e as Error).message));
  }, [settleFilter]);

  const refreshFeatures = useCallback(() => {
    return authFetch("/admin/features")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load features");
        setFeatures(json.flags ?? []);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const refreshAds = useCallback(() => {
    return authFetch("/admin/ads")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load ads");
        setAdsEnabled(Boolean(json.adsEnabled));
        setAdCampaigns((json.campaigns as AdCampaign[]) ?? []);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const refreshTurnover = useCallback(() => {
    return authFetch(`/admin/analytics/turnover?period=${analyticsPeriod}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load turnover");
        setTurnover(json as TurnoverReport);
      })
      .catch((e) => setErr((e as Error).message));
  }, [analyticsPeriod]);

  function downloadTurnoverCsv() {
    if (!turnover) return;
    const headers = [
      "kitchen",
      "slug",
      "pin",
      "route_acc",
      "food_gmv_inr",
      "delivery_inr",
      "platform_fee_inr",
      "customer_charge_inr",
      "plates",
      "orders",
      "delivered",
      "held",
      "refunded_food_inr",
      "settled_net_inr",
      "commission_inr",
      "manual_paid_inr",
      "transfer_completed_inr",
    ];
    const lines = [
      headers.join(","),
      ...turnover.cooks.map((c) =>
        [
          JSON.stringify(c.kitchenName),
          c.slugHandle,
          c.pinCode ?? "",
          c.payoutBeneficiaryRef ?? "",
          (c.foodGmvPaise / 100).toFixed(2),
          (c.deliveryPaise / 100).toFixed(2),
          (c.platformFeePaise / 100).toFixed(2),
          (c.customerChargePaise / 100).toFixed(2),
          c.plates,
          c.orderCount,
          c.deliveredOrderCount,
          c.heldOrderCount,
          (c.refundedFoodPaise / 100).toFixed(2),
          (c.settledNetPaise / 100).toFixed(2),
          ((c.commissionPaise ?? 0) / 100).toFixed(2),
          (c.manualPaidPaise / 100).toFixed(2),
          (c.transferCompletedPaise / 100).toFixed(2),
        ].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `localmeals-turnover-${turnover.range.period}-${turnover.range.from}_${turnover.range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function toggleFeature(key: string, enabled: boolean) {
    setBusy(`feat-${key}`);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/admin/features/${key}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update flag");
      setFeatures(json.flags ?? []);
      setMsg(`${key} → ${enabled ? "ON" : "OFF"}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function savePricing() {
    const fee = Number(feeDraft.trim());
    const bps = percentTextToBps(commissionPctDraft);
    if (!feeDraft.trim() || !Number.isFinite(fee) || fee < 0) {
      setErr("Enter a platform fee in ₹ (0 or more)");
      return;
    }
    if (bps == null) {
      setErr("Enter a commission % (0 or more)");
      return;
    }
    setBusy("pricing");
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch("/admin/pricing", {
        method: "PATCH",
        body: JSON.stringify({ platformFeePaise: Math.round(fee * 100), cookCommissionBps: bps }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save pricing");
      applyPricing(json as Pricing);
      setMsg(
        `Pricing saved: ₹${(json.platformFeePaise / 100).toFixed(2)} fee · ${bpsToPercentText(json.cookCommissionBps)}% commission (new orders)`,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function refreshAll() {
    setErr(null);
    authFetch("/admin/tickets")
      .then((r) => r.json())
      .then(setTickets);
    void refreshCooks();
    void refreshSettlements();
    void refreshFeatures();
    void refreshPricing();
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshSettlements();
  }, [refreshSettlements]);

  useEffect(() => {
    if (tab === "analytics") void refreshTurnover();
  }, [tab, refreshTurnover]);

  useEffect(() => {
    if (tab === "ads") void refreshAds();
  }, [tab, refreshAds]);

  useEffect(() => {
    if (tab === "orders") void refreshAttention();
  }, [tab]);

  async function refreshAttention() {
    try {
      const res = await authFetch("/admin/orders-attention");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load attention queue");
      setAttentionRows(Array.isArray(json.orders) ? json.orders : []);
    } catch (e) {
      setAttentionRows([]);
      setErr((e as Error).message);
    }
  }

  async function runOrderSearch() {
    setBusy("order-search");
    setErr(null);
    setMsg(null);
    try {
      const q = new URLSearchParams();
      if (searchMobile.trim()) q.set("mobile", searchMobile.trim());
      if (searchCook.trim()) q.set("cookSlug", searchCook.trim());
      if (searchDate.trim()) q.set("serviceDate", searchDate.trim());
      if (searchStatus.trim()) q.set("status", searchStatus.trim());
      q.set("limit", "40");
      const res = await authFetch(`/admin/orders?${q.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed");
      setSearchRows(Array.isArray(json.orders) ? json.orders : []);
      if (!json.orders?.length) setMsg(t("admin.searchEmpty"));
    } catch (e) {
      setSearchRows([]);
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function openSupport(publicId: string) {
    setOrderLookup(publicId);
    setBusy("order-lookup");
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/admin/orders/${encodeURIComponent(publicId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Order not found");
      setSupportBundle(json as SupportBundle);
    } catch (e) {
      setSupportBundle(null);
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function refund(orderId: number, ticketId: number, mode: "FULL" | "FOOD_ONLY") {
    const res = await authFetch("/internal/ops/refunds", {
      method: "POST",
      body: JSON.stringify({
        orderId,
        ticketId,
        mode,
        reason: "Admin resolution from MVP console",
      }),
    });
    setMsg(JSON.stringify(await res.json()));
    refreshAll();
  }

  async function hold(orderId: number) {
    const res = await authFetch("/internal/ops/holds", {
      method: "POST",
      body: JSON.stringify({ orderId, reason: "Dispute pending" }),
    });
    setMsg(JSON.stringify(await res.json()));
  }

  async function pause(cookId: string) {
    const res = await authFetch(`/internal/ops/cooks/${cookId}/pause`, {
      method: "POST",
      body: JSON.stringify({ reason: "Ops pause" }),
    });
    setMsg(JSON.stringify(await res.json()));
    void refreshCooks();
  }

  async function saveCookPayout(cookId: string) {
    const commissionBps = percentTextToBps(cookCommissionDraft[cookId] ?? "");
    if (commissionBps === undefined) {
      setErr("Commission override must be a number (or blank for the default)");
      return;
    }
    setBusy(`cook-${cookId}`);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/admin/cooks/${cookId}/payout-details`, {
        method: "POST",
        body: JSON.stringify({
          payoutUpiId: (upiDraft[cookId] ?? "").trim() || null,
          payoutAccountNote: (noteDraft[cookId] ?? "").trim() || null,
          payoutBeneficiaryRef: (routeDraft[cookId] ?? "").trim() || null,
          pickupLandmark: (landmarkDraft[cookId] ?? "").trim() || null,
          pickupEnabled: Boolean(pickupOnDraft[cookId]),
          deliveryType: deliveryTypeDraft[cookId] === "PARTNER" ? "PARTNER" : "SELF",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      const cook = cooks.find((c) => c.id === cookId);
      if (commissionBps !== (cook?.commissionBps ?? null)) {
        const cr = await authFetch(`/admin/cooks/${cookId}/commission`, {
          method: "POST",
          body: JSON.stringify({ commissionBps }),
        });
        const cj = await cr.json();
        if (!cr.ok) throw new Error(cj.error ?? "Commission save failed");
      }
      setMsg(`Saved cook details for ${json.kitchenName ?? cookId}`);
      await refreshCooks();
      await refreshSettlements();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function approveCookLive(cookId: string) {
    setBusy(`approve-${cookId}`);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/admin/cooks/${cookId}/approve`, { method: "POST", body: "{}" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Approve failed");
      setMsg(`Approved LIVE · ${json.kitchenName ?? cookId}`);
      await refreshCooks();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function markPaid(settlementId: number) {
    setBusy(`settle-${settlementId}`);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/admin/settlements/${settlementId}/manual-pay`, {
        method: "POST",
        body: JSON.stringify({
          utr: (utrDraft[settlementId] ?? "").trim(),
          note: (payNoteDraft[settlementId] ?? "").trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Mark paid failed");
      setMsg(`Marked settlement #${settlementId} paid · ${json.manualUtr ?? ""}`);
      setUtrDraft((p) => ({ ...p, [settlementId]: "" }));
      await refreshSettlements();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runEod() {
    setBusy("eod");
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch("/admin/settlements/run-eod", { method: "POST", body: "{}" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "EOD failed");
      setMsg(
        `EOD ${json.businessDate}: ${json.batches?.length ?? 0} batch(es), ${json.skipped?.length ?? 0} skipped`,
      );
      await refreshSettlements();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const openRows = settlements.filter((s) => s.needsManualPay);
  const openTotal = openRows.reduce((n, s) => n + s.netPaise, 0);
  const overdueRows = openRows.filter((s) => s.overdue);
  const overdueTotal = overdueRows.reduce((n, s) => n + s.netPaise, 0);

  async function lookupOrder() {
    const id = orderLookup.trim();
    if (!id) return;
    setBusy("order-lookup");
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/admin/orders/${encodeURIComponent(id)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Order not found");
      setSupportBundle(json as SupportBundle);
    } catch (e) {
      setSupportBundle(null);
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveAdCampaign() {
    setBusy("ad-save");
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch("/admin/ads", {
        method: "POST",
        body: JSON.stringify({
          type: adForm.type,
          status: adForm.status,
          pinCode: adForm.pinCode,
          cookId: adForm.type === "KITCHEN_BOOST" && adForm.cookId ? adForm.cookId : null,
          title: adForm.title.trim(),
          body: adForm.body.trim() || null,
          ctaUrl: adForm.ctaUrl.trim() || null,
          priority: Number(adForm.priority) || 0,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save campaign");
      setMsg(t("admin.adSaved"));
      setAdForm((f) => ({ ...f, title: "", body: "", ctaUrl: "", cookId: "" }));
      await refreshAds();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function setAdStatus(id: number, status: AdCampaign["status"]) {
    setBusy(`ad-${id}`);
    setErr(null);
    try {
      const res = await authFetch(`/admin/ads/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update status");
      await refreshAds();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const tabLabels: Record<Tab, string> = {
    payouts: t("admin.tabPayouts"),
    analytics: t("admin.tabAnalytics"),
    features: t("admin.tabFeatures"),
    ads: t("admin.tabAds"),
    cooks: t("admin.tabCooks"),
    tickets: t("admin.tabTickets"),
    orders: t("admin.tabOrders"),
    parties: t("cat.myParties"),
  };

  return (
    <main className="admin-page">
      <header className="page-head">
        <h1>{t("admin.title")}</h1>
        <p className="muted">{t("admin.blurb")}</p>
      </header>

      <div className="seg desk-tabs" role="tablist" aria-label={t("admin.title")}>
        {(
          ["payouts", "analytics", "features", "ads", "cooks", "tickets", "orders", "parties"] as const
        ).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={tab === id ? "on" : ""}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {tabLabels[id]}
          </button>
        ))}
      </div>

      {err ? <p className="err">{err}</p> : null}
      {msg ? <pre className="ok">{msg}</pre> : null}

      {tab === "parties" ? <CateringAdminPanel /> : null}

      {tab === "analytics" ? (
        <section>
          <div className="card">
            <strong>{t("admin.analyticsTitle")}</strong>
            <p className="muted" style={{ margin: "0.35rem 0 0.75rem" }}>
              {t("admin.analyticsBlurb")}
            </p>
            <div className="seg" role="group" aria-label={t("admin.period")}>
              {(["week", "month", "year"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={analyticsPeriod === p ? "on" : ""}
                  onClick={() => setAnalyticsPeriod(p)}
                >
                  {p === "week"
                    ? t("admin.period.week")
                    : p === "month"
                      ? t("admin.period.month")
                      : t("admin.period.year")}
                </button>
              ))}
            </div>
            <div className="actions" style={{ marginTop: "0.65rem" }}>
              <button className="btn sm" type="button" onClick={() => void refreshTurnover()}>
                {t("admin.refresh")}
              </button>
              <button
                className="btn sm secondary"
                type="button"
                disabled={!turnover?.cooks.length}
                onClick={downloadTurnoverCsv}
              >
                {t("admin.exportCsv")}
              </button>
            </div>
          </div>

          {turnover ? (
            <>
              <p className="muted" style={{ marginTop: "0.75rem" }}>
                {turnover.range.label} · LIVE cooks {turnover.liveCookCount}
              </p>

              <div className="admin-table-wrap" style={{ marginTop: "0.55rem" }}>
                <table className="admin-table">
                  <caption>{t("admin.platformTotals")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("admin.foodGmv")}</th>
                      <th scope="col">{t("admin.platformFees")}</th>
                      <th scope="col">{t("admin.deliveryFees")}</th>
                      <th scope="col">{t("admin.customerCharges")}</th>
                      <th scope="col">{t("admin.colPlates")}</th>
                      <th scope="col">{t("admin.colOrders")}</th>
                      <th scope="col">{t("admin.settledNet")}</th>
                      <th scope="col">{t("admin.commission")}</th>
                      <th scope="col">{t("admin.refundedFood")}</th>
                      <th scope="col">{t("admin.cooksWithVolume")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{rupees(turnover.platform.foodGmvPaise)}</td>
                      <td>{rupees(turnover.platform.platformFeePaise)}</td>
                      <td>{rupees(turnover.platform.deliveryPaise)}</td>
                      <td>{rupees(turnover.platform.customerChargePaise)}</td>
                      <td>{turnover.platform.plates}</td>
                      <td>{turnover.platform.orderCount}</td>
                      <td>{rupees(turnover.platform.settledNetPaise)}</td>
                      <td>{rupees(turnover.platform.commissionPaise ?? 0)}</td>
                      <td>{rupees(turnover.platform.refundedFoodPaise)}</td>
                      <td>{turnover.platform.cookCountWithVolume}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {turnover.cooks.length === 0 ? (
                <p className="muted">{t("admin.noTurnover")}</p>
              ) : (
                <div className="admin-table-wrap" style={{ marginTop: "0.75rem" }}>
                  <table className="admin-table">
                    <caption>{t("admin.byCook")}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("admin.colKitchen")}</th>
                        <th scope="col">{t("admin.foodGmv")}</th>
                        <th scope="col">{t("admin.platformFees")}</th>
                        <th scope="col">{t("admin.deliveryFees")}</th>
                        <th scope="col">{t("admin.colPlates")}</th>
                        <th scope="col">{t("admin.colOrders")}</th>
                        <th scope="col">{t("admin.colDelivered")}</th>
                        <th scope="col">{t("admin.colHold")}</th>
                        <th scope="col">{t("admin.settledNet")}</th>
                        <th scope="col">{t("admin.commission")}</th>
                        <th scope="col">{t("admin.colManual")}</th>
                        <th scope="col">{t("admin.colRoute")}</th>
                        <th scope="col">{t("admin.refundedFood")}</th>
                        <th scope="col">{t("admin.desk")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {turnover.cooks.map((c) => (
                        <tr key={c.cookId}>
                          <td>
                            <div className="admin-table-kitchen">
                              <strong>{c.kitchenName}</strong>
                              <span className="chip">{c.onboardingStatus}</span>
                            </div>
                            <div className="muted admin-table-sub">
                              /{c.slugHandle}
                              {c.pinCode ? ` · PIN ${c.pinCode}` : ""}
                              {c.payoutBeneficiaryRef ? ` · ${c.payoutBeneficiaryRef}` : ""}
                            </div>
                          </td>
                          <td>{rupees(c.foodGmvPaise)}</td>
                          <td>{rupees(c.platformFeePaise)}</td>
                          <td>{rupees(c.deliveryPaise)}</td>
                          <td>{c.plates}</td>
                          <td>{c.orderCount}</td>
                          <td>{c.deliveredOrderCount}</td>
                          <td>{c.heldOrderCount || "—"}</td>
                          <td>{rupees(c.settledNetPaise)}</td>
                          <td>{c.commissionPaise ? rupees(c.commissionPaise) : "—"}</td>
                          <td>{c.manualPaidPaise ? rupees(c.manualPaidPaise) : "—"}</td>
                          <td>
                            {c.transferCompletedPaise
                              ? rupees(c.transferCompletedPaise)
                              : "—"}
                          </td>
                          <td>
                            {c.refundedFoodPaise > 0
                              ? rupees(c.refundedFoodPaise)
                              : "—"}
                          </td>
                          <td>
                            {c.slugHandle ? (
                              <Link href={`/cook/${c.slugHandle}`}>{t("admin.desk")}</Link>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <p className="muted">{t("admin.loadingAnalytics")}</p>
          )}
        </section>
      ) : null}

      {tab === "features" ? (
        <section>
          <div className="card">
            <strong>{t("admin.pricingTitle")}</strong>
            <p className="muted" style={{ margin: "0.35rem 0 0" }}>
              {t("admin.pricingBlurb")}
            </p>
            <label className="order-field" style={{ marginTop: "0.55rem" }}>
              {t("admin.platformFeeInr", {
                max: pricing ? (pricing.maxPlatformFeePaise / 100).toFixed(0) : "50",
              })}
              <input
                inputMode="decimal"
                value={feeDraft}
                onChange={(e) => setFeeDraft(e.target.value)}
              />
            </label>
            <label className="order-field" style={{ marginTop: "0.55rem" }}>
              {t("admin.commissionPercent", {
                max: pricing ? bpsToPercentText(pricing.maxCookCommissionBps) : "10",
              })}
              <input
                inputMode="decimal"
                value={commissionPctDraft}
                onChange={(e) => setCommissionPctDraft(e.target.value)}
              />
            </label>
            {pricing?.updatedBy ? (
              <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>
                {t("admin.pricingUpdatedBy", { by: pricing.updatedBy })}
              </p>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={busy === "pricing" || !pricing}
                onClick={() => void savePricing()}
              >
                {busy === "pricing" ? t("admin.saving") : t("admin.savePricing")}
              </button>
            </div>
          </div>
          <div className="card">
            <strong>{t("admin.featureToggles")}</strong>
            <p className="muted" style={{ margin: "0.35rem 0 0" }}>
              {t("admin.featureBlurb")}
            </p>
          </div>
          {features.length === 0 ? (
            <p className="muted">{t("admin.loadingFlags")}</p>
          ) : null}
          {features.map((f) => (
            <div key={f.key} className="card">
              <div className="row">
                <div>
                  <strong>{f.label}</strong>
                  <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                    {f.description}
                  </p>
                  <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.8rem" }}>
                    <code>{f.key}</code>
                    {f.updatedBy
                      ? ` · last ${f.enabled ? "on" : "off"} by ${f.updatedBy}`
                      : null}
                  </p>
                </div>
                <button
                  type="button"
                  className={`btn sm ${f.enabled ? "mustard" : "secondary"}`}
                  disabled={busy === `feat-${f.key}`}
                  onClick={() => void toggleFeature(f.key, !f.enabled)}
                >
                  {busy === `feat-${f.key}` ? "…" : f.enabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {tab === "ads" ? (
        <section>
          <div className="card">
            <strong>{t("admin.adsTitle")}</strong>
            <p className="muted" style={{ margin: "0.35rem 0 0" }}>
              {t("admin.adsBlurb")}
            </p>
            <p className="muted" style={{ margin: "0.5rem 0 0" }}>
              {t("admin.adsKillSwitch")}:{" "}
              <strong>{adsEnabled ? "ON" : "OFF"}</strong>
              {" · "}
              <code>ads_enabled</code> ({t("admin.tabFeatures")})
            </p>
          </div>

          <div className="card">
            <strong>{t("admin.adNew")}</strong>
            <div className="row" style={{ flexWrap: "wrap", gap: "0.75rem", marginTop: "0.75rem" }}>
              <label>
                <span className="muted">{t("admin.adType")}</span>
                <select
                  value={adForm.type}
                  onChange={(e) =>
                    setAdForm((f) => ({
                      ...f,
                      type: e.target.value as "KITCHEN_BOOST" | "EXTERNAL",
                    }))
                  }
                >
                  <option value="EXTERNAL">EXTERNAL</option>
                  <option value="KITCHEN_BOOST">KITCHEN_BOOST</option>
                </select>
              </label>
              <label>
                <span className="muted">{t("admin.adStatus")}</span>
                <select
                  value={adForm.status}
                  onChange={(e) =>
                    setAdForm((f) => ({
                      ...f,
                      status: e.target.value as AdCampaign["status"],
                    }))
                  }
                >
                  {(["DRAFT", "ACTIVE", "PAUSED", "ENDED"] as const).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="muted">PIN</span>
                <input
                  value={adForm.pinCode}
                  maxLength={6}
                  onChange={(e) =>
                    setAdForm((f) => ({
                      ...f,
                      pinCode: e.target.value.replace(/\D/g, "").slice(0, 6),
                    }))
                  }
                />
              </label>
              {adForm.type === "KITCHEN_BOOST" ? (
                <label>
                  <span className="muted">cookId</span>
                  <input
                    value={adForm.cookId}
                    placeholder="uuid"
                    onChange={(e) => setAdForm((f) => ({ ...f, cookId: e.target.value }))}
                  />
                </label>
              ) : null}
              <label style={{ flex: "1 1 12rem" }}>
                <span className="muted">{t("admin.adTitleField")}</span>
                <input
                  value={adForm.title}
                  onChange={(e) => setAdForm((f) => ({ ...f, title: e.target.value }))}
                />
              </label>
              <label style={{ flex: "1 1 12rem" }}>
                <span className="muted">CTA URL</span>
                <input
                  value={adForm.ctaUrl}
                  onChange={(e) => setAdForm((f) => ({ ...f, ctaUrl: e.target.value }))}
                />
              </label>
              <label>
                <span className="muted">{t("admin.adPriority")}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={adForm.priority}
                  onChange={(e) => setAdForm((f) => ({ ...f, priority: e.target.value }))}
                />
              </label>
            </div>
            <label style={{ display: "block", marginTop: "0.5rem" }}>
              <span className="muted">{t("admin.adBody")}</span>
              <textarea
                rows={2}
                value={adForm.body}
                onChange={(e) => setAdForm((f) => ({ ...f, body: e.target.value }))}
              />
            </label>
            <button
              className="btn mustard"
              type="button"
              style={{ marginTop: "0.75rem" }}
              disabled={busy === "ad-save" || adForm.title.trim().length < 2}
              onClick={() => void saveAdCampaign()}
            >
              {busy === "ad-save" ? "…" : t("admin.adSave")}
            </button>
          </div>

          {adCampaigns.length === 0 ? (
            <p className="muted">{t("admin.adsEmpty")}</p>
          ) : (
            adCampaigns.map((c) => (
              <div key={c.id} className="card">
                <div className="row">
                  <div>
                    <strong>
                      #{c.id} · {c.title}
                    </strong>
                    <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                      {c.type} · {c.status} · pin {c.pinCode}
                      {c.kitchenName ? ` · ${c.kitchenName}` : ""}
                      {c.cookSlug ? ` (@${c.cookSlug})` : ""}
                      {` · prio ${c.priority}`}
                    </p>
                  </div>
                  <div className="actions">
                    {c.status !== "ACTIVE" ? (
                      <button
                        type="button"
                        className="btn sm mustard"
                        disabled={busy === `ad-${c.id}` || !adsEnabled}
                        onClick={() => void setAdStatus(c.id, "ACTIVE")}
                      >
                        {t("admin.adActivate")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn sm secondary"
                        disabled={busy === `ad-${c.id}`}
                        onClick={() => void setAdStatus(c.id, "PAUSED")}
                      >
                        {t("admin.adPause")}
                      </button>
                    )}
                    {c.status !== "ENDED" ? (
                      <button
                        type="button"
                        className="btn sm secondary"
                        disabled={busy === `ad-${c.id}`}
                        onClick={() => void setAdStatus(c.id, "ENDED")}
                      >
                        {t("admin.adEnd")}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
          )}
        </section>
      ) : null}

      {tab === "payouts" ? (
        <section>
          <div className="card admin-payout-hero">
            <div>
              <p className="muted" style={{ margin: 0 }}>
                {t("admin.openToPay")}
              </p>
              <strong className="admin-payout-total">{rupees(openTotal)}</strong>
              <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                {t("admin.openCount", { n: openRows.length })}
                {overdueRows.length > 0
                  ? ` · ${t("admin.unpaidDays", { n: 1 })} (${rupees(overdueTotal)})`
                  : ""}
              </p>
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              <button
                className="btn mustard"
                type="button"
                disabled={busy === "eod"}
                onClick={() => void runEod()}
              >
                {busy === "eod" ? t("admin.running") : t("admin.runEod")}
              </button>
              <div className="seg">
                <button
                  type="button"
                  className={settleFilter === "open" ? "on" : ""}
                  onClick={() => setSettleFilter("open")}
                >
                  {t("admin.open")}
                </button>
                <button
                  type="button"
                  className={settleFilter === "all" ? "on" : ""}
                  onClick={() => setSettleFilter("all")}
                >
                  {t("admin.all")}
                </button>
              </div>
            </div>
          </div>

          {settlements.length === 0 ? (
            <div className="card empty-card">
              <p className="muted">{t("admin.noSettlements")}</p>
            </div>
          ) : null}

          {settlements.map((s) => (
            <div key={s.id} className="card admin-settle-card">
              <div className="day-head">
                <h2 className="order-card-title">
                  {s.kitchenName} · {s.businessDate}
                </h2>
                <span
                  className={`chip ${
                    s.overdue ? "tone-bad" : s.needsManualPay ? "tone-warn" : "tone-done"
                  }`}
                >
                  {s.manualPaidAt || s.status === "MANUAL_PAID"
                    ? t("admin.paidManually")
                    : s.overdue
                      ? t("admin.unpaidDays", { n: s.ageDays ?? 0 })
                      : s.status}
                </span>
              </div>
              <ul className="meta-list">
                <li>
                  {t("admin.orders")}: {s.orderCount}
                </li>
                {typeof s.grossPaise === "number" ? (
                  <li>
                    {t("admin.grossFood")}: {rupees(s.grossPaise)}
                  </li>
                ) : null}
                {(s.feesPaise ?? 0) > 0 ? (
                  <li>
                    {t("admin.commission")}: −{rupees(s.feesPaise ?? 0)}
                  </li>
                ) : null}
                {(s.clawbackPaise ?? 0) > 0 ? (
                  <li>
                    {t("admin.clawbackApplied")}: −{rupees(s.clawbackPaise ?? 0)}
                  </li>
                ) : null}
                <li>
                  {t("admin.payNet")}: {rupees(s.netPaise)}
                </li>
                {(s.pendingClawbackPaise ?? 0) > 0 ? (
                  <li>
                    {t("admin.clawbackPending")}: {rupees(s.pendingClawbackPaise ?? 0)}
                  </li>
                ) : null}
                {s.needsManualPay && typeof s.ageDays === "number" ? (
                  <li>
                    {s.ageDays === 0
                      ? t("admin.owedToday")
                      : t("admin.unpaidDays", { n: s.ageDays })}
                  </li>
                ) : null}
                {s.cookMobile ? <li>{s.cookMobile}</li> : null}
                {s.cookSlug ? (
                  <li>
                    <Link href={`/cook/${s.cookSlug}`}>{t("admin.desk")}</Link>
                  </li>
                ) : null}
              </ul>
              <div className="admin-pay-box">
                <p className="muted" style={{ margin: "0 0 0.35rem" }}>
                  {t("admin.payTo")}
                </p>
                <p style={{ margin: 0, fontWeight: 650 }}>
                  {s.payoutUpiId || t("admin.upiMissing")}
                </p>
                {s.payoutAccountNote ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap" }}>
                    {s.payoutAccountNote}
                  </p>
                ) : null}
                {s.payoutBeneficiaryRef ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                    Route: {s.payoutBeneficiaryRef}
                  </p>
                ) : null}
              </div>
              {s.needsManualPay ? (
                <div className="admin-mark-paid">
                  <label className="order-field">
                    {t("admin.utr")}
                    <input
                      value={utrDraft[s.id] ?? ""}
                      onChange={(e) =>
                        setUtrDraft((p) => ({ ...p, [s.id]: e.target.value }))
                      }
                      placeholder="e.g. 312345678901"
                    />
                  </label>
                  <label className="order-field">
                    {t("admin.noteOptional")}
                    <input
                      value={payNoteDraft[s.id] ?? ""}
                      onChange={(e) =>
                        setPayNoteDraft((p) => ({ ...p, [s.id]: e.target.value }))
                      }
                      placeholder="Paid via GPay"
                    />
                  </label>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy === `settle-${s.id}`}
                    onClick={() => void markPaid(s.id)}
                  >
                    {busy === `settle-${s.id}`
                      ? t("admin.saving")
                      : t("admin.markPaid", { amount: (s.netPaise / 100).toFixed(2) })}
                  </button>
                </div>
              ) : (
                <p className="ok" style={{ marginTop: "0.75rem" }}>
                  {s.manualUtr
                    ? `UTR ${s.manualUtr}${s.manualPaidAt ? ` · ${new Date(s.manualPaidAt).toLocaleString()}` : ""}`
                    : s.gatewayBatchId
                      ? `Ref ${s.gatewayBatchId}`
                      : s.status}
                </p>
              )}
            </div>
          ))}
        </section>
      ) : null}

      {tab === "cooks" ? (
        <section>
          {cooks.map((c) => (
            <div key={c.id} className="card">
              <div className="row">
                <strong>{c.kitchenName}</strong>
                <span className="chip">
                  {c.onboardingStatus} · {c.isActive ? t("admin.active") : t("admin.paused")}
                </span>
              </div>
              <p style={{ margin: "0.35rem 0 0", display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                <span
                  className={`chip ${
                    (deliveryTypeDraft[c.id] ?? c.deliveryType) === "PARTNER"
                      ? "tone-done"
                      : "tone-neutral"
                  }`}
                >
                  {(deliveryTypeDraft[c.id] ?? c.deliveryType) === "PARTNER"
                    ? t("admin.badgePartner")
                    : t("admin.badgeSelf")}
                </span>
              </p>
              {c.onboardingStatus !== "LIVE" ? (
                <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                  {t("admin.pendingApply")}
                </p>
              ) : null}
              <p className="muted" style={{ margin: "0.35rem 0" }}>
                /{c.slugHandle}
                {c.mobileNumber ? ` · ${c.mobileNumber}` : ""}
                {c.fssaiNumber ? ` · FSSAI ${c.fssaiNumber}` : ` · ${t("admin.fssaiMissing")}`}
              </p>
              <label className="order-field">
                {t("admin.upiId")}
                <input
                  value={upiDraft[c.id] ?? ""}
                  placeholder="cook@upi"
                  onChange={(e) =>
                    setUpiDraft((prev) => ({ ...prev, [c.id]: e.target.value }))
                  }
                />
              </label>
              <label className="order-field" style={{ marginTop: "0.55rem" }}>
                {t("admin.bankNote")}
                <input
                  value={noteDraft[c.id] ?? ""}
                  placeholder="Name · account · IFSC"
                  onChange={(e) =>
                    setNoteDraft((prev) => ({ ...prev, [c.id]: e.target.value }))
                  }
                />
              </label>
              <label className="order-field" style={{ marginTop: "0.55rem" }}>
                {t("admin.routeOptional")}
                <input
                  value={routeDraft[c.id] ?? ""}
                  placeholder="acc_…"
                  onChange={(e) =>
                    setRouteDraft((prev) => ({ ...prev, [c.id]: e.target.value }))
                  }
                />
              </label>
              <label className="order-field" style={{ marginTop: "0.55rem" }}>
                {t("admin.pickupLandmark")}
                <input
                  value={landmarkDraft[c.id] ?? ""}
                  placeholder="Near Sholinganallur signal, OMR"
                  onChange={(e) =>
                    setLandmarkDraft((prev) => ({ ...prev, [c.id]: e.target.value }))
                  }
                />
              </label>
              <label
                className="muted"
                style={{ display: "flex", gap: "0.45rem", alignItems: "center", marginTop: "0.55rem" }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(pickupOnDraft[c.id])}
                  onChange={(e) =>
                    setPickupOnDraft((prev) => ({ ...prev, [c.id]: e.target.checked }))
                  }
                />
                {t("admin.offerPickup")}
              </label>
              <label className="order-field" style={{ marginTop: "0.55rem" }}>
                {t("admin.cookCommission", {
                  pct: pricing ? bpsToPercentText(pricing.cookCommissionBps) : "—",
                })}
                <input
                  inputMode="decimal"
                  value={cookCommissionDraft[c.id] ?? ""}
                  placeholder={pricing ? bpsToPercentText(pricing.cookCommissionBps) : ""}
                  onChange={(e) =>
                    setCookCommissionDraft((prev) => ({ ...prev, [c.id]: e.target.value }))
                  }
                />
              </label>
              <label className="order-field" style={{ marginTop: "0.55rem" }}>
                {t("admin.deliveryType")}
                <select
                  value={deliveryTypeDraft[c.id] ?? "SELF"}
                  onChange={(e) =>
                    setDeliveryTypeDraft((prev) => ({
                      ...prev,
                      [c.id]: e.target.value === "PARTNER" ? "PARTNER" : "SELF",
                    }))
                  }
                >
                  <option value="SELF">{t("admin.deliverySelf")}</option>
                  <option value="PARTNER">{t("admin.deliveryPartner")}</option>
                </select>
              </label>
              {deliveryTypeDraft[c.id] === "PARTNER" ? (
                <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                  {t("admin.deliveryPartnerHint")}
                </p>
              ) : null}
              <div className="actions">
                <button
                  className="btn"
                  type="button"
                  disabled={busy === `cook-${c.id}`}
                  onClick={() => void saveCookPayout(c.id)}
                >
                  {busy === `cook-${c.id}` ? t("admin.saving") : t("admin.saveCook")}
                </button>
                {c.onboardingStatus !== "LIVE" ? (
                  <button
                    className="btn mustard"
                    type="button"
                    disabled={busy === `approve-${c.id}`}
                    onClick={() => void approveCookLive(c.id)}
                  >
                    {busy === `approve-${c.id}` ? t("admin.saving") : t("admin.approveLive")}
                  </button>
                ) : null}
                <Link href={`/cook/${c.slugHandle}`}>{t("admin.desk")}</Link>
                {c.isActive ? (
                  <button className="btn secondary" type="button" onClick={() => pause(c.id)}>
                    {t("admin.pauseCook")}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {tab === "tickets" ? (
        <section>
          <h2>{t("admin.tabTickets")}</h2>
          {tickets.length === 0 ? <p className="muted">{t("admin.noTickets")}</p> : null}
          {tickets.map((ticket) => {
            const slaPast =
              ticket.status === "OPEN" &&
              ticket.slaDueAt != null &&
              new Date(ticket.slaDueAt).getTime() < Date.now();
            return (
            <div key={ticket.id} className={`card${slaPast ? " ticket-sla-breached" : ""}`}>
              <div className="row">
                <strong>
                  #{ticket.id} {ticket.summary}
                </strong>
                <span className="chip">{ticket.status}</span>
                {slaPast ? <span className="chip tone-warn">SLA past due</span> : null}
                {ticket.source === "COOK" ? <span className="chip">Cook</span> : null}
              </div>
              <p className="muted">
                {ticket.category} · orderId {ticket.orderId ?? "—"}
                {ticket.slaDueAt
                  ? ` · SLA ${new Date(ticket.slaDueAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
                  : ""}
                {ticket.decision ? ` · ${ticket.decision}` : ""}
              </p>
              {ticket.orderId && ticket.status === "OPEN" ? (
                <div className="actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => refund(ticket.orderId!, ticket.id, "FULL")}
                  >
                    {t("admin.fullRefund")}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => refund(ticket.orderId!, ticket.id, "FOOD_ONLY")}
                  >
                    {t("admin.foodOnly")}
                  </button>
                  <button
                    className="btn mustard"
                    type="button"
                    onClick={() => hold(ticket.orderId!)}
                  >
                    {t("admin.holdSettlement")}
                  </button>
                  <Link href={adminHref(`tickets/${ticket.id}`)}>{t("admin.detail")}</Link>
                </div>
              ) : (
                <div className="actions">
                  <Link href={adminHref(`tickets/${ticket.id}`)}>{t("admin.detail")}</Link>
                </div>
              )}
            </div>
            );
          })}
        </section>
      ) : null}

      {tab === "orders" ? (
        <section>
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem" }}>
              <strong>{t("admin.attentionTitle")}</strong>
              <button
                className="btn secondary"
                type="button"
                disabled={busy === "attention"}
                onClick={() => {
                  setBusy("attention");
                  void refreshAttention().finally(() => setBusy(null));
                }}
              >
                {t("admin.attentionRefresh")}
              </button>
            </div>
            <p className="muted" style={{ margin: "0.35rem 0 0.75rem" }}>
              {t("admin.attentionBlurb")}
            </p>
            {attentionRows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {t("admin.attentionEmpty")}
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {attentionRows.map((o) => (
                  <li
                    key={o.publicId}
                    style={{
                      marginBottom: "0.55rem",
                      paddingBottom: "0.45rem",
                      borderBottom: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
                    }}
                  >
                    <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                      <strong>
                        {o.publicId} · {o.qty}× {o.itemName}
                      </strong>
                      <span className="chip tone-warn">{o.reason}</span>
                    </div>
                    <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                      {o.serviceDate} · {o.kitchenName ?? o.cookSlug ?? "—"} · {o.customerMobile} ·{" "}
                      {rupees(o.totalPaise)}
                    </p>
                    <button
                      className="btn sm"
                      type="button"
                      style={{ marginTop: "0.35rem" }}
                      onClick={() => void openSupport(o.publicId)}
                    >
                      {t("admin.openSupport")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card" style={{ marginTop: "0.75rem" }}>
            <strong>{t("admin.searchTitle")}</strong>
            <p className="muted" style={{ margin: "0.35rem 0 0.75rem" }}>
              {t("admin.searchBlurb")}
            </p>
            <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
              <input
                value={searchMobile}
                placeholder={t("admin.searchMobile")}
                onChange={(e) => setSearchMobile(e.target.value)}
                style={{ flex: "1 1 9rem", minWidth: "8rem" }}
              />
              <input
                value={searchCook}
                placeholder={t("admin.searchCook")}
                onChange={(e) => setSearchCook(e.target.value)}
                style={{ flex: "1 1 9rem", minWidth: "8rem" }}
              />
              <input
                type="date"
                value={searchDate}
                aria-label={t("admin.searchDate")}
                onChange={(e) => setSearchDate(e.target.value)}
                style={{ flex: "0 1 9rem" }}
              />
              <select
                value={searchStatus}
                aria-label={t("admin.searchStatus")}
                onChange={(e) => setSearchStatus(e.target.value)}
                style={{ flex: "0 1 10rem" }}
              >
                <option value="">{t("admin.searchAnyStatus")}</option>
                {[
                  "AWAITING_PAYMENT",
                  "CONFIRMING_PAYMENT",
                  "PAID",
                  "COOKING",
                  "PACKED",
                  "DISPATCHED",
                  "DELIVERED",
                  "CANCEL_REQUESTED",
                  "CANCELLED",
                  "REFUNDED",
                  "FAILED",
                  "LOGISTICS_EXCEPTION",
                ].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                type="button"
                disabled={busy === "order-search"}
                onClick={() => void runOrderSearch()}
              >
                {busy === "order-search" ? "…" : t("admin.searchRun")}
              </button>
            </div>
            {searchRows.length > 0 ? (
              <ul style={{ listStyle: "none", margin: "0.75rem 0 0", padding: 0 }}>
                {searchRows.map((o) => (
                  <li
                    key={o.publicId}
                    style={{
                      marginBottom: "0.55rem",
                      paddingBottom: "0.45rem",
                      borderBottom: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
                    }}
                  >
                    <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                      <strong>
                        {o.publicId} · {o.qty}× {o.itemName}
                      </strong>
                      <span className="chip">{o.status}</span>
                      {o.settlementHold ? (
                        <span className="chip tone-warn">{t("admin.onHold")}</span>
                      ) : null}
                    </div>
                    <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                      {o.serviceDate} · {o.kitchenName ?? o.cookSlug ?? "—"} · {o.customerMobile} ·{" "}
                      {rupees(o.totalPaise)}
                    </p>
                    <button
                      className="btn sm"
                      type="button"
                      style={{ marginTop: "0.35rem" }}
                      onClick={() => void openSupport(o.publicId)}
                    >
                      {t("admin.openSupport")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="card" style={{ marginTop: "0.75rem" }}>
            <strong>{t("admin.orderSupportTitle")}</strong>
            <p className="muted" style={{ margin: "0.35rem 0 0.75rem" }}>
              {t("admin.orderSupportBlurb")}
            </p>
            <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
              <input
                value={orderLookup}
                placeholder="LM-… / checkout / trc_… / txn"
                onChange={(e) => setOrderLookup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void lookupOrder();
                }}
                style={{ flex: "1 1 12rem", minWidth: "10rem" }}
              />
              <button
                className="btn"
                type="button"
                disabled={busy === "order-lookup" || !orderLookup.trim()}
                onClick={() => void lookupOrder()}
              >
                {busy === "order-lookup" ? "…" : t("admin.lookupOrder")}
              </button>
            </div>
          </div>

          {supportBundle ? (
            <>
              <div className="card" style={{ marginTop: "0.75rem" }}>
                <div className="row">
                  <strong>
                    {supportBundle.order.publicId} · {supportBundle.order.qty}×{" "}
                    {supportBundle.order.itemName}
                  </strong>
                  <span className="chip">{supportBundle.order.status}</span>
                </div>
                <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                  {supportBundle.order.serviceDate} · {supportBundle.order.mealType} ·{" "}
                  {rupees(supportBundle.order.totalPaise)}
                  {supportBundle.order.foodDiscountPaise > 0
                    ? ` (−${rupees(supportBundle.order.foodDiscountPaise)} week off)`
                    : ""}
                  {supportBundle.matchedBy ? ` · matched ${supportBundle.matchedBy}` : ""}
                </p>
                <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                  {t("admin.customer")}: {supportBundle.order.customerMobile}
                  {supportBundle.order.payerMobile
                    ? ` · payer ${supportBundle.order.payerMobile}`
                    : ""}
                </p>
                {supportBundle.cook ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                    {supportBundle.cook.kitchenName} · /{supportBundle.cook.slugHandle} ·{" "}
                    {supportBundle.cook.mobileNumber}
                  </p>
                ) : null}
                {supportBundle.order.traceId ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0", wordBreak: "break-all" }}>
                    {t("admin.traceId")}: <code>{supportBundle.order.traceId}</code>
                  </p>
                ) : null}
                {supportBundle.order.gatewayTxnId ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0", wordBreak: "break-all" }}>
                    txn {supportBundle.order.gatewayTxnId}
                  </p>
                ) : null}
                {supportBundle.order.deliveryTargetAddress ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                    {supportBundle.order.deliveryTargetAddress}
                  </p>
                ) : null}
                {supportBundle.cloudLogging ? (
                  <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                    {t("admin.cloudLoggingHint")}:{" "}
                    <code>{supportBundle.cloudLogging.byTraceId}</code>
                  </p>
                ) : null}
                {supportBundle.order.settlementHold ? (
                  <p className="err" style={{ margin: "0.35rem 0 0" }}>
                    {t("admin.onHold")}
                  </p>
                ) : null}
                <div className="actions" style={{ marginTop: "0.65rem" }}>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy === `refund-${supportBundle.order.publicId}`}
                    onClick={() => {
                      // reuse numeric refund via publicId endpoint
                      void (async () => {
                        setBusy(`refund-${supportBundle.order.publicId}`);
                        setErr(null);
                        try {
                          const res = await authFetch(
                            `/orders/${supportBundle.order.publicId}/refund`,
                            {
                              method: "POST",
                              body: JSON.stringify({
                                mode: "FULL",
                                reason: "Admin support refund",
                              }),
                            },
                          );
                          const json = await res.json();
                          if (!res.ok) throw new Error(json.error ?? "Refund failed");
                          setMsg(t("admin.refunded"));
                          await lookupOrder();
                        } catch (e) {
                          setErr((e as Error).message);
                        } finally {
                          setBusy(null);
                        }
                      })();
                    }}
                  >
                    {t("admin.fullRefund")}
                  </button>
                </div>
              </div>

              {supportBundle.checkout ? (
                <div className="card" style={{ marginTop: "0.75rem" }}>
                  <strong>
                    {t("admin.weekCheckout")} {supportBundle.checkout.checkoutId}
                  </strong>
                  <ul className="meta-list" style={{ marginTop: "0.5rem" }}>
                    {supportBundle.checkout.lines.map((line) => (
                      <li key={line.publicId}>
                        {line.publicId} · {line.serviceDate} · {line.mealType} · {line.status} ·{" "}
                        {rupees(line.totalPaise)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="card" style={{ marginTop: "0.75rem" }}>
                <strong>{t("admin.payments")}</strong>
                {supportBundle.payments.length === 0 ? (
                  <p className="muted">{t("admin.noPayments")}</p>
                ) : (
                  <ul className="meta-list" style={{ marginTop: "0.5rem" }}>
                    {supportBundle.payments.map((p) => (
                      <li key={p.id}>
                        {p.kind} · {p.status} · {rupees(p.amountPaise)}
                        {p.gatewayTxnId ? ` · ${p.gatewayTxnId}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="card" style={{ marginTop: "0.75rem" }}>
                <strong>{t("admin.outbox")}</strong>
                {!supportBundle.outbox?.length ? (
                  <p className="muted">{t("admin.noOutbox")}</p>
                ) : (
                  <ul className="meta-list" style={{ marginTop: "0.5rem" }}>
                    {supportBundle.outbox.map((o) => (
                      <li key={o.id} style={{ marginBottom: "0.35rem" }}>
                        <span className="chip" style={{ marginRight: "0.35rem" }}>
                          {o.status}
                        </span>
                        {o.eventName}
                        <span className="muted">
                          {" "}
                          · try {o.attempts}
                          {o.lastError ? ` · ${o.lastError}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="card" style={{ marginTop: "0.75rem" }}>
                <strong>{t("admin.activityTimeline")}</strong>
                {supportBundle.activity.length === 0 ? (
                  <p className="muted">{t("admin.noActivity")}</p>
                ) : (
                  <ol className="meta-list" style={{ marginTop: "0.5rem" }}>
                    {supportBundle.activity.map((a) => (
                      <li key={a.id} style={{ marginBottom: "0.45rem" }}>
                        <span className="chip" style={{ marginRight: "0.35rem" }}>
                          {a.source}
                        </span>
                        <strong>{a.eventName}</strong>
                        <span className="muted">
                          {" "}
                          · {new Date(a.at).toLocaleString()} · {a.channel}
                          {a.actor ? ` · ${a.actor}` : ""}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

export default function AdminPage() {
  return (
    <RequireAuth role="ADMIN">
      <AdminInner />
    </RequireAuth>
  );
}
