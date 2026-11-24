"use client";

import { uploadSrc } from "@/lib/uploadUrl";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { API_BASE } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import { loadFeatureFlags } from "@/lib/features";
import { prepareMenuPhoto } from "@/lib/menuImage";
import { groupCookStops, type CookStopGroup } from "@/lib/cookStops";
import { cookNextAction, customerStatusLabel, statusTone } from "@/lib/orderStatus";
import type { MsgKey } from "@localmeals/i18n";
import { CookDeskHero } from "./CookDeskHero";
import { CookSettingsCards } from "./CookSettingsCards";
import type { DeskReview, Manifest, MealType, MenuItem, WaFeedItem } from "./types";

type ManifestOrder = Manifest["orders"][number];
type DeskStop = CookStopGroup<ManifestOrder>;

function mapsLinkForAddress(address: string) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

const DAY_KEYS = [
  "day.sun",
  "day.mon",
  "day.tue",
  "day.wed",
  "day.thu",
  "day.fri",
  "day.sat",
] as const satisfies readonly MsgKey[];
const MEAL_IDS: MealType[] = ["BREAKFAST", "LUNCH", "DINNER"];
const MEAL_KEYS: Record<MealType, MsgKey> = {
  BREAKFAST: "meal.breakfast",
  LUNCH: "meal.lunch",
  DINNER: "meal.dinner",
};

const imgSrc = uploadSrc;

function CookDeskInner() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const { t } = useLocale();
  const dayLabels = DAY_KEYS.map((k) => t(k));
  const mealTabs = MEAL_IDS.map((id) => ({ id, label: t(MEAL_KEYS[id]) }));
  const [mealType, setMealType] = useState<MealType>("LUNCH");
  const [mealEnabled, setMealEnabled] = useState(true);
  const [data, setData] = useState<Manifest | null>(null);
  const [waFeed, setWaFeed] = useState<WaFeedItem[]>([]);
  const [cookMobile, setCookMobile] = useState("");
  const [latePending, setLatePending] = useState<
    Array<{
      id: number;
      publicId: string;
      itemName: string;
      qty: number;
      spice: string;
      customerMobile: string;
      deliveryTargetAddress: string;
      status: string;
    }>
  >([]);
  const [cancelPending, setCancelPending] = useState<
    Array<{
      publicId: string;
      itemName: string;
      qty: number;
      customerMobile: string;
      deliveryTargetAddress: string | null;
      status: string;
      serviceDate?: string;
      mealType?: string;
    }>
  >([]);
  const [menus, setMenus] = useState<MenuItem[]>([]);
  const [weeklyForDay, setWeeklyForDay] = useState<MenuItem[]>([]);
  const [weekByDay, setWeekByDay] = useState<Record<string, MenuItem[]>>({});
  const [serviceDate, setServiceDate] = useState<string>("");
  const [tab, setTab] = useState<"day" | "week">("day");
  const [deskPanel, setDeskPanel] = useState<"run" | "menu" | "reviews">("run");
  const [deskReviews, setDeskReviews] = useState<DeskReview[]>([]);
  const [reviewSummary, setReviewSummary] = useState<{
    average: number | null;
    count: number;
    public: boolean;
  } | null>(null);
  const [reviewSoftMin, setReviewSoftMin] = useState(3);
  const [replyDraft, setReplyDraft] = useState<Record<number, string>>({});
  const [replyEditing, setReplyEditing] = useState<Record<number, boolean>>({});
  const [replyBusy, setReplyBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hour, setHour] = useState(8);
  const [minute, setMinute] = useState(0);
  const [winStartH, setWinStartH] = useState(12);
  const [winStartM, setWinStartM] = useState(0);
  const [winEndH, setWinEndH] = useState(13);
  const [winEndM, setWinEndM] = useState(0);
  const [weekPct, setWeekPct] = useState(0);
  const [weekMinDays, setWeekMinDays] = useState(3);
  const [weekPlatformOn, setWeekPlatformOn] = useState(true);
  const [pickupOn, setPickupOn] = useState(false);
  const [pickupLandmark, setPickupLandmark] = useState("");
  const [pickupPlatformOn, setPickupPlatformOn] = useState(false);
  const [partnerActive, setPartnerActive] = useState(false);
  const [partnerPlatformOn, setPartnerPlatformOn] = useState(false);
  const [deliveryType, setDeliveryType] = useState<"SELF" | "PARTNER">("SELF");
  const [savingPickup, setSavingPickup] = useState(false);
  const [intakePaused, setIntakePaused] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [lateOrdersEnabled, setLateOrdersEnabled] = useState(true);
  const [latePlatformEnabled, setLatePlatformEnabled] = useState(true);
  const [togglingLate, setTogglingLate] = useState(false);
  const [upcomingDays, setUpcomingDays] = useState<
    Array<{
      serviceDate: string;
      dayLabel: string;
      mealType: string;
      totalPlates: number;
      lines: Array<{ itemName: string; itemNameTa?: string | null; qty: number; orderCount: number }>;
    }>
  >([]);
  const [offerCookDelivery, setOfferCookDelivery] = useState(true);
  const [offerCustomerArrange, setOfferCustomerArrange] = useState(false);
  const [savingFulfillment, setSavingFulfillment] = useState(false);
  const [menuTemplates, setMenuTemplates] = useState<
    Array<{ id: number; name: string; itemCount: number }>
  >([]);
  const [templateName, setTemplateName] = useState("");
  const [postingTemplateId, setPostingTemplateId] = useState<number | null>(null);
  const [adsEnabled, setAdsEnabled] = useState(false);
  const [boostBusy, setBoostBusy] = useState(false);
  const [boostCampaigns, setBoostCampaigns] = useState<
    Array<{ id: number; status: string; title: string; endsAt: string | null }>
  >([]);

  const [itemName, setItemName] = useState("");
  const [itemNameTa, setItemNameTa] = useState("");
  const [priceRupees, setPriceRupees] = useState("80");
  const [isVeg, setIsVeg] = useState(true);
  const [targetDate, setTargetDate] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [postMode, setPostMode] = useState<"date" | "weekly">("date");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoBusyId, setPhotoBusyId] = useState<number | null>(null);
  const [savingMenu, setSavingMenu] = useState(false);
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  const [savedPlates, setSavedPlates] = useState<
    Array<{
      id: number;
      itemName: string;
      itemNameTa: string | null;
      pricePaise: number;
      isVeg: boolean;
      imageUrl: string | null;
    }>
  >([]);
  const [postingSavedId, setPostingSavedId] = useState<number | null>(null);

  useEffect(() => {
    if (user?.role === "COOK" && user.cookSlug && user.cookSlug !== slug) {
      router.replace(`/cook/${user.cookSlug}`);
    }
  }, [user, slug, router]);

  const loadMenu = useCallback(
    (view: "day" | "week" = tab, date?: string) => {
      const q = new URLSearchParams();
      if (view === "week") q.set("view", "week");
      if (date) q.set("date", date);
      q.set("meal", mealType);
      authFetch(`/cooks/${slug}/menu?${q}`)
        .then(async (r) => {
          const json = await r.json();
          if (!r.ok) throw new Error(json.error ?? "Failed to load menu");
          if (view === "week") {
            setWeekByDay(json.byDay ?? {});
            setMenus(json.menus ?? []);
          } else {
            setMenus(json.menus ?? []);
            setWeeklyForDay(json.weeklyForDay ?? []);
            setServiceDate(json.serviceDate ?? "");
            if (!targetDate && json.serviceDate) setTargetDate(json.serviceDate);
          }
        })
        .catch((e) => setErr(String(e)));
    },
    [slug, tab, targetDate, mealType],
  );

  const loadWaFeed = useCallback(() => {
    authFetch(`/cooks/${slug}/whatsapp-feed`)
      .then((r) => r.json())
      .then((json: { cookMobile?: string; messages?: WaFeedItem[] }) => {
        setCookMobile(json.cookMobile ?? "");
        setWaFeed(json.messages ?? []);
      })
      .catch(() => undefined);
  }, [slug]);

  const loadSavedPlates = useCallback(() => {
    authFetch(`/cooks/${slug}/saved-plates?meal=${mealType}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load saved plates");
        setSavedPlates(json.plates ?? []);
      })
      .catch(() => setSavedPlates([]));
  }, [slug, mealType]);

  const loadMenuTemplates = useCallback(() => {
    authFetch(`/cooks/${slug}/menu-templates?meal=${mealType}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load templates");
        setMenuTemplates(
          (json.templates ?? []).map(
            (t: { id: number; name: string; itemCount?: number; items?: unknown[] }) => ({
              id: t.id,
              name: t.name,
              itemCount: t.itemCount ?? (Array.isArray(t.items) ? t.items.length : 0),
            }),
          ),
        );
      })
      .catch(() => setMenuTemplates([]));
  }, [slug, mealType]);

  const loadLatePending = useCallback(() => {
    const date = targetDate || serviceDate;
    const q = date ? `?date=${encodeURIComponent(date)}` : "";
    authFetch(`/cooks/${slug}/late-pending${q}`)
      .then((r) => r.json())
      .then((json: { orders?: typeof latePending }) => {
        setLatePending(json.orders ?? []);
      })
      .catch(() => setLatePending([]));
  }, [slug, targetDate, serviceDate]);

  const loadCancelPending = useCallback(() => {
    // No date filter — show every pending cancel ask from today forward (week cart).
    authFetch(`/cooks/${slug}/cancel-pending`)
      .then((r) => r.json())
      .then((json: { orders?: typeof cancelPending }) => {
        setCancelPending(json.orders ?? []);
      })
      .catch(() => setCancelPending([]));
  }, [slug]);

  const loadReviews = useCallback(() => {
    authFetch(`/cooks/${slug}/reviews`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load reviews");
        setDeskReviews(json.reviews ?? []);
        setReviewSummary(json.summary ?? null);
        if (typeof json.softLaunchMin === "number") setReviewSoftMin(json.softLaunchMin);
      })
      .catch((e) => setErr(String(e)));
  }, [slug]);

  const loadBoosts = useCallback(() => {
    authFetch(`/cooks/${slug}/ads`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) return;
        setAdsEnabled(Boolean(json.adsEnabled));
        setBoostCampaigns(
          ((json.campaigns as Array<{
            id: number;
            status: string;
            title: string;
            endsAt: string | null;
          }>) ?? []).map((c) => ({
            id: c.id,
            status: c.status,
            title: c.title,
            endsAt: c.endsAt,
          })),
        );
      })
      .catch(() => {
        setAdsEnabled(false);
        setBoostCampaigns([]);
      });
  }, [slug]);

  async function requestBoost() {
    setBoostBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/cooks/${slug}/ads/boost`, {
        method: "POST",
        body: JSON.stringify({ days: 7 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not request boost");
      setMsg(json.note ?? t("cook.boostRequested"));
      loadBoosts();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBoostBusy(false);
    }
  }

  const loadKitchenExtras = useCallback(() => {
    void Promise.all([
      authFetch(`/cooks/${slug}/meal-settings`).then(async (r) => {
        const json = await r.json();
        if (!r.ok) return null;
        return json as {
          weekDiscount?: { percent?: number; minDays?: number; platformEnabled?: boolean };
          pickup?: { enabled?: boolean; landmark?: string | null; platformEnabled?: boolean };
          intake?: { paused?: boolean };
          lateOrders?: { enabled?: boolean; platformEnabled?: boolean };
          fulfillmentOffers?: {
            cookDelivery?: boolean;
            pickup?: boolean;
            customerArrange?: boolean;
          };
          delivery?: {
            type?: string;
            platformPartnerEnabled?: boolean;
            partnerActive?: boolean;
          };
        };
      }),
      // Platform kill switches (authoritative) — shared client cache.
      loadFeatureFlags().catch(() => null),
      // Kitchen deliveryType is on the public cook DTO even when meal-settings omits delivery.
      fetch(`${API_BASE}/kitchens/${slug}/menu`)
        .then(async (r) =>
          r.ok
            ? ((await r.json()) as { cook?: { deliveryType?: string } })
            : null,
        )
        .catch(() => null),
    ])
      .then(([json, flags, kitchen]) => {
        if (flags && typeof flags.pickup_enabled === "boolean") {
          setPickupPlatformOn(flags.pickup_enabled);
        }
        const platformPartner =
          flags && typeof flags.partner_delivery_enabled === "boolean"
            ? flags.partner_delivery_enabled
            : Boolean(json?.delivery?.platformPartnerEnabled);
        setPartnerPlatformOn(platformPartner);

        if (json?.weekDiscount) {
          setWeekPct(json.weekDiscount.percent ?? 0);
          setWeekMinDays(json.weekDiscount.minDays ?? 3);
          setWeekPlatformOn(json.weekDiscount.platformEnabled !== false);
        }
        if (json?.pickup) {
          setPickupOn(Boolean(json.pickup.enabled));
          setPickupLandmark(json.pickup.landmark ?? "");
          if (typeof json.pickup.platformEnabled === "boolean") {
            setPickupPlatformOn(Boolean(json.pickup.platformEnabled));
          }
        }
        if (json?.intake) {
          setIntakePaused(Boolean(json.intake.paused));
        }
        if (json?.lateOrders) {
          setLateOrdersEnabled(json.lateOrders.enabled !== false);
          if (typeof json.lateOrders.platformEnabled === "boolean") {
            setLatePlatformEnabled(Boolean(json.lateOrders.platformEnabled));
          }
        }
        if (json?.fulfillmentOffers) {
          setOfferCookDelivery(json.fulfillmentOffers.cookDelivery !== false);
          setOfferCustomerArrange(Boolean(json.fulfillmentOffers.customerArrange));
          if (typeof json.fulfillmentOffers.pickup === "boolean") {
            setPickupOn(Boolean(json.fulfillmentOffers.pickup));
          }
        }

        const typeFromSettings = json?.delivery?.type;
        const typeFromKitchen = kitchen?.cook?.deliveryType;
        const type: "SELF" | "PARTNER" =
          typeFromSettings === "PARTNER" || typeFromKitchen === "PARTNER"
            ? "PARTNER"
            : "SELF";
        setDeliveryType(type);
        setPartnerActive(
          Boolean(json?.delivery?.partnerActive) || (platformPartner && type === "PARTNER"),
        );
      })
      .catch(() => undefined);
  }, [slug]);

  async function sendReply(reviewId: number) {
    const reply = (replyDraft[reviewId] ?? "").trim();
    if (!reply) return;
    setReplyBusy(reviewId);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/cooks/${slug}/reviews/${reviewId}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Reply failed");
      setMsg(t("cook.replyPosted"));
      setReplyDraft((d) => ({ ...d, [reviewId]: "" }));
      setReplyEditing((d) => ({ ...d, [reviewId]: false }));
      loadReviews();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setReplyBusy(null);
    }
  }

  const load = useCallback(() => {
    // Don't hit another kitchen's APIs while we redirect to the cook's own slug.
    if (user?.role === "COOK" && user.cookSlug && user.cookSlug !== slug) {
      return;
    }
    setErr(null);
    void authFetch(`/cooks/${slug}/upcoming-orders?days=7`)
      .then(async (r) => {
        const json = (await r.json()) as {
          days?: typeof upcomingDays;
          error?: string;
        };
        if (!r.ok) {
          setUpcomingDays([]);
          return;
        }
        setUpcomingDays(Array.isArray(json.days) ? json.days : []);
      })
      .catch(() => setUpcomingDays([]));

    authFetch(`/cooks/${slug}/manifest?meal=${mealType}`)
      .then(async (r) => {
        const json = (await r.json()) as Manifest & {
          mealEnabled?: boolean;
          cutoff?: string;
          error?: string;
        };
        if (!r.ok) {
          setData(null);
          setErr(json.error ?? t("cook.loadFailed"));
          return;
        }
        if (!Array.isArray(json.orders)) {
          setData(null);
          setErr(t("cook.loadFailed"));
          return;
        }
        setData({ ...json, orders: json.orders });
        setMealEnabled(json.mealEnabled !== false);
        if (json.delivery) {
          setDeliveryType(json.delivery.type === "PARTNER" ? "PARTNER" : "SELF");
          setPartnerPlatformOn(Boolean(json.delivery.platformPartnerEnabled));
          setPartnerActive(Boolean(json.delivery.partnerActive));
        } else if (json.cook?.deliveryType === "PARTNER") {
          setDeliveryType("PARTNER");
        }
        const cutoffLabel = json.cutoff ?? json.lunchCutoff;
        if (cutoffLabel) {
          const [h, m] = cutoffLabel.split(":").map(Number);
          setHour(h);
          setMinute(m);
        }
        if (json.deliveryWindowParts) {
          setWinStartH(json.deliveryWindowParts.startHour);
          setWinStartM(json.deliveryWindowParts.startMinute);
          setWinEndH(json.deliveryWindowParts.endHour);
          setWinEndM(json.deliveryWindowParts.endMinute);
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    loadMenu(tab, targetDate || undefined);
    loadWaFeed();
    loadLatePending();
    loadCancelPending();
    loadSavedPlates();
    loadMenuTemplates();
    loadBoosts();
  }, [
    slug,
    user,
    loadMenu,
    loadWaFeed,
    loadLatePending,
    loadCancelPending,
    loadSavedPlates,
    loadMenuTemplates,
    loadBoosts,
    tab,
    targetDate,
    mealType,
    t,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadMenu(tab, targetDate || undefined);
  }, [tab, targetDate, loadMenu]);

  function formatCookActionMsg(path: string, json: Record<string, unknown>) {
    if (typeof json.error === "string") return null;
    const ids = Array.isArray(json.publicIds) ? json.publicIds.length : 0;
    if (path.includes("/cooking") || "cooking" in json) {
      const n = typeof json.cooking === "number" ? json.cooking : ids;
      return n > 0 ? t("cook.startedCooking", { n }) : t("cook.done");
    }
    if (path.includes("/pack") || "packed" in json) {
      const n = typeof json.packed === "number" ? json.packed : ids;
      return n > 0 ? t("cook.markedPacked", { n }) : t("cook.done");
    }
    if (path.includes("/dispatch") || "dispatched" in json) {
      const n = typeof json.dispatched === "number" ? json.dispatched : ids;
      const partner =
        typeof json.partnerAssigned === "number" && json.partnerAssigned > 0
          ? ` · ${t("cook.partnerActive")}`
          : "";
      return n > 0 ? `${t("cook.dispatched", { n })}${partner}` : t("cook.done");
    }
    if (path.includes("/rider-assigned")) {
      return t("status.cook.riderAssigned");
    }
    if (path.includes("/delivered") || json.status === "DELIVERED") {
      return t("cook.markedDelivered", { n: 1 });
    }
    if (path.includes("/late-approve")) return t("cook.lateApproved");
    if (path.includes("/late-decline")) return t("cook.lateDeclined");
    if (path.includes("/cancel-accept")) return t("cook.cancelAccepted");
    if (path.includes("/cancel-decline")) return t("cook.cancelDeclined");
    if (typeof json.publicId === "string") return t("cook.done");
    return t("cook.done");
  }

  async function post(path: string, body?: object) {
    setErr(null);
    setMsg(null);
    const res = await authFetch(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      setErr(typeof json.error === "string" ? json.error : t("cook.actionFailed"));
      return;
    }
    setMsg(formatCookActionMsg(path, json));
    load();
    if (path.includes("/cancel-") || path.includes("/late-")) {
      loadLatePending();
      loadCancelPending();
    }
  }

  async function saveCutoff() {
    const res = await authFetch(`/cooks/${slug}/meal-settings/${mealType}`, {
      method: "PATCH",
      body: JSON.stringify({ cutoffHour: hour, cutoffMinute: minute }),
    });
    const json = await res.json();
    if (!res.ok) {
      setErr(json.error ?? "Could not save cut-off");
      return;
    }
    setMsg(`${mealType} cut-off saved`);
    load();
  }

  async function saveDeliveryWindow() {
    const res = await authFetch(`/cooks/${slug}/meal-settings/${mealType}`, {
      method: "PATCH",
      body: JSON.stringify({
        deliveryWindow: {
          startHour: winStartH,
          startMinute: winStartM,
          endHour: winEndH,
          endMinute: winEndM,
        },
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setErr(json.error ?? "Could not save delivery window");
      return;
    }
    const meal = json.meals?.find((m: { mealType: string }) => m.mealType === mealType);
    setMsg(`Delivery window ${meal?.deliveryWindowLabel ?? "saved"}`);
    load();
  }

  async function saveWeekDiscount() {
    const res = await authFetch(`/cooks/${slug}/week-discount`, {
      method: "PATCH",
      body: JSON.stringify({ percent: weekPct, minDays: weekMinDays }),
    });
    const json = await res.json();
    if (!res.ok) {
      setErr(json.error ?? "Could not save week discount");
      return;
    }
    setWeekPct(json.weekDiscountPercent ?? 0);
    setWeekMinDays(json.weekDiscountMinDays ?? 3);
    setMsg(json.label ? `Week discount: ${json.label}` : "Week discount turned off");
  }

  async function savePickupSettings() {
    const landmark = pickupLandmark.trim();
    if (pickupOn && !landmark) {
      setErr(t("cook.pickupNeedsLandmark"));
      return;
    }
    setSavingPickup(true);
    setErr(null);
    try {
      const res = await authFetch(`/cooks/${slug}/pickup`, {
        method: "PATCH",
        body: JSON.stringify({
          pickupEnabled: pickupOn,
          pickupLandmark: landmark || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save pickup");
      setPickupOn(Boolean(json.pickupEnabled));
      setPickupLandmark(json.pickupLandmark ?? "");
      setPickupPlatformOn(Boolean(json.platformEnabled));
      setMsg(t("cook.pickupSaved"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingPickup(false);
    }
  }

  async function toggleIntakePause() {
    setTogglingPause(true);
    setErr(null);
    try {
      const res = await authFetch(`/cooks/${slug}/intake-pause`, {
        method: "PATCH",
        body: JSON.stringify({ paused: !intakePaused }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update pause");
      setIntakePaused(Boolean(json.paused));
      setMsg(t("cook.pauseSaved"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setTogglingPause(false);
    }
  }

  async function toggleLateOrders() {
    setTogglingLate(true);
    setErr(null);
    try {
      const res = await authFetch(`/cooks/${slug}/late-orders`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !lateOrdersEnabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update late orders");
      setLateOrdersEnabled(Boolean(json.enabled));
      if (typeof json.platformEnabled === "boolean") {
        setLatePlatformEnabled(Boolean(json.platformEnabled));
      }
      setMsg(t("cook.lateSaved"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setTogglingLate(false);
    }
  }

  async function saveFulfillmentOffers() {
    const landmark = pickupLandmark.trim();
    if (pickupOn && !landmark) {
      setErr(t("cook.pickupNeedsLandmark"));
      return;
    }
    setSavingFulfillment(true);
    setErr(null);
    try {
      const res = await authFetch(`/cooks/${slug}/fulfillment`, {
        method: "PATCH",
        body: JSON.stringify({
          cookDelivery: offerCookDelivery,
          customerArrange: offerCustomerArrange,
          pickupEnabled: pickupOn,
          pickupLandmark: landmark || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save fulfillment");
      const offers = json.fulfillmentOffers ?? {};
      setOfferCookDelivery(offers.cookDelivery !== false);
      setOfferCustomerArrange(Boolean(offers.customerArrange));
      setPickupOn(Boolean(json.pickupEnabled ?? offers.pickup));
      setPickupLandmark(json.pickupLandmark ?? landmark);
      if (typeof json.pickupPlatformEnabled === "boolean") {
        setPickupPlatformOn(Boolean(json.pickupPlatformEnabled));
      }
      setMsg(t("cook.fulfillmentSaved"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingFulfillment(false);
    }
  }

  async function saveTemplateFromDay() {
    const name = templateName.trim();
    if (name.length < 2) {
      setErr(t("cook.templateName"));
      return;
    }
    setErr(null);
    try {
      const res = await authFetch(`/cooks/${slug}/menu-templates`, {
        method: "POST",
        body: JSON.stringify({
          name,
          mealType,
          fromServiceDate: menuDate || serviceDate || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save plan");
      setTemplateName("");
      setMsg(t("cook.templateSaved"));
      loadMenuTemplates();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function postMenuTemplate(id: number) {
    setPostingTemplateId(id);
    setErr(null);
    try {
      const res = await authFetch(`/cooks/${slug}/menu-templates/${id}/post`, {
        method: "POST",
        body: JSON.stringify({
          serviceDate: menuDate || serviceDate || undefined,
          weekly: postMode === "weekly",
          dayOfWeek: postMode === "weekly" ? dayOfWeek : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not post plan");
      setMsg(t("cook.templatePosted", { n: json.count ?? 0 }));
      loadMenu();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPostingTemplateId(null);
    }
  }

  async function removeMenuTemplate(id: number, name: string) {
    if (!confirm(t("cook.removeSavedConfirm", { name }))) return;
    const res = await authFetch(`/cooks/${slug}/menu-templates/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setErr(json.error ?? "Could not remove plan");
      return;
    }
    loadMenuTemplates();
  }

  useEffect(() => {
    loadKitchenExtras();
  }, [loadKitchenExtras]);

  async function toggleMealEnabled(enabled: boolean) {
    if (mealType === "LUNCH") return;
    const res = await authFetch(`/cooks/${slug}/meal-settings/${mealType}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    const json = await res.json();
    if (!res.ok) {
      setErr(json.error ?? "Could not update meal");
      return;
    }
    setMealEnabled(enabled);
    setMsg(`${mealType} ${enabled ? "enabled" : "disabled"}`);
    load();
  }

  async function uploadPhoto(): Promise<string | null> {
    if (!photoFile) return null;
    const prepared = await prepareMenuPhoto(photoFile);
    const fd = new FormData();
    fd.append("file", prepared);
    const res = await authFetch(`/cooks/${slug}/menu/photo`, {
      method: "POST",
      body: fd,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Photo upload failed");
    return json.url as string;
  }

  async function addMenuItem() {
    setSavingMenu(true);
    setErr(null);
    try {
      const imageUrl = await uploadPhoto();
      const iso = targetDate || serviceDate;
      const weeklyDow = iso ? weekdayFromISO(iso) : dayOfWeek;
      const payload =
        postMode === "weekly"
          ? {
              itemName,
              itemNameTa: itemNameTa.trim() || null,
              priceRupees: Number(priceRupees),
              isVeg,
              weekly: true,
              dayOfWeek: weeklyDow,
              serviceDate: null,
              imageUrl,
              mealType,
              saveToLibrary,
            }
          : {
              itemName,
              itemNameTa: itemNameTa.trim() || null,
              priceRupees: Number(priceRupees),
              isVeg,
              serviceDate: iso || undefined,
              imageUrl,
              mealType,
              saveToLibrary,
            };
      const res = await authFetch(`/cooks/${slug}/menu`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not add menu item");
      setItemName("");
      setItemNameTa("");
      setPhotoFile(null);
      setMsg(
        postMode === "weekly"
          ? `Added weekly · ${dayLabels[weeklyDow]} · ${json.itemName}`
          : `Added ${json.itemName} · ${iso}`,
      );
      loadMenu(tab, targetDate || undefined);
      if (saveToLibrary) loadSavedPlates();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingMenu(false);
    }
  }

  async function toggleAvailable(item: MenuItem) {
    setErr(null);
    const res = await authFetch(`/cooks/${slug}/menu/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isAvailable: !item.isAvailable }),
    });
    const json = await res.json();
    if (!res.ok) {
      setErr(json.error ?? "Update failed");
      return;
    }
    loadMenu(tab, targetDate || undefined);
  }

  async function deletePlate(item: MenuItem) {
    const ok = window.confirm(t("cook.deletePlateConfirm", { name: item.itemName }));
    if (!ok) return;
    setErr(null);
    setMsg(null);
    const res = await authFetch(`/cooks/${slug}/menu/${item.id}`, { method: "DELETE" });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setErr(json.error ?? t("cook.actionFailed"));
      return;
    }
    setMsg(t("cook.plateDeleted"));
    loadMenu(tab, targetDate || undefined);
  }

  async function savePlateToLibrary(item: MenuItem) {
    setErr(null);
    setMsg(null);
    const res = await authFetch(`/cooks/${slug}/saved-plates`, {
      method: "POST",
      body: JSON.stringify({ fromMenuId: item.id }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setErr(json.error ?? t("cook.actionFailed"));
      return;
    }
    setMsg(t("cook.plateSaved"));
    loadSavedPlates();
  }

  async function postSavedPlate(savedId: number) {
    setPostingSavedId(savedId);
    setErr(null);
    setMsg(null);
    try {
      const iso = targetDate || serviceDate;
      const dow = iso ? weekdayFromISO(iso) : dayOfWeek;
      const res = await authFetch(`/cooks/${slug}/saved-plates/${savedId}/post`, {
        method: "POST",
        body: JSON.stringify(
          postMode === "weekly"
            ? { weekly: true, serviceDate: iso || null, dayOfWeek: dow }
            : { serviceDate: iso || undefined },
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? t("cook.actionFailed"));
      setMsg(t("cook.savedPosted", { name: json.itemName ?? "" }));
      setTab("day");
      loadMenu("day", iso || undefined);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPostingSavedId(null);
    }
  }

  async function removeSavedPlate(savedId: number, name: string) {
    const ok = window.confirm(t("cook.removeSavedConfirm", { name }));
    if (!ok) return;
    const res = await authFetch(`/cooks/${slug}/saved-plates/${savedId}`, { method: "DELETE" });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setErr(typeof json.error === "string" ? json.error : t("cook.actionFailed"));
      return;
    }
    loadSavedPlates();
  }

  async function attachPhoto(item: MenuItem, file: File) {
    setErr(null);
    setMsg(null);
    setPhotoBusyId(item.id);
    try {
      const prepared = await prepareMenuPhoto(file);
      const fd = new FormData();
      fd.append("file", prepared);
      const up = await authFetch(`/cooks/${slug}/menu/photo`, {
        method: "POST",
        body: fd,
      });
      const upJson = await up.json();
      if (!up.ok) throw new Error(upJson.error ?? "Upload failed");
      const res = await authFetch(`/cooks/${slug}/menu/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ imageUrl: upJson.url }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save photo");
      setMsg(`Photo saved · ${item.itemName}`);
      loadMenu(tab, targetDate || undefined);
      loadSavedPlates();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPhotoBusyId(null);
    }
  }

  function renderItem(m: MenuItem) {
    const src = imgSrc(m.imageUrl);
    const weekly = m.serviceDate == null && m.dayOfWeek != null;
    return (
      <article key={m.id} className="cook-plate-row">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="cook-plate-thumb" src={src} alt="" />
        ) : (
          <div className="cook-plate-thumb cook-plate-thumb-empty" aria-hidden />
        )}
        <div className="cook-plate-body">
          <div className="cook-plate-top">
            <div className="cook-plate-meta">
              <strong>{m.itemName}</strong>
              <span className="cook-plate-price">₹{(m.pricePaise / 100).toFixed(0)}</span>
            </div>
            <span className={`chip cook-plate-status ${m.isAvailable ? "tone-done" : "tone-neutral"}`}>
              {m.isAvailable ? t("cook.on") : t("cook.off")}
            </span>
          </div>
          <p className="cook-plate-sub muted">
            {m.itemNameTa ? `${m.itemNameTa} · ` : ""}
            {m.isVeg ? t("cook.veg") : t("common.nonVeg")}
            {weekly ? ` · ${t("cook.everyDay", { day: dayLabels[m.dayOfWeek!] })}` : ""}
          </p>
          <div className="cook-plate-actions">
            <label className={`cook-plate-link${photoBusyId === m.id ? " is-busy" : ""}`}>
              {photoBusyId === m.id ? t("cook.sending") : t("cook.photo")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif"
                className="cook-file-input"
                disabled={photoBusyId === m.id}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void attachPhoto(m, f);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              className="cook-plate-link"
              type="button"
              onClick={() => toggleAvailable(m)}
            >
              {m.isAvailable ? t("cook.hide") : t("cook.show")}
            </button>
            <button
              className="cook-plate-link"
              type="button"
              onClick={() => void savePlateToLibrary(m)}
            >
              {t("cook.savePlateToLibrary")}
            </button>
            <button
              className="cook-plate-link cook-plate-link-danger"
              type="button"
              onClick={() => void deletePlate(m)}
            >
              {t("cook.deletePlate")}
            </button>
          </div>
        </div>
      </article>
    );
  }

  function switchMenuTab(next: "day" | "week") {
    setTab(next);
  }

  function weekdayFromISO(iso: string) {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return 1;
    return new Date(y, m - 1, d).getDay();
  }

  function setMenuDate(next: string) {
    setTargetDate(next);
    if (postMode === "weekly") {
      setDayOfWeek(weekdayFromISO(next));
    }
  }

  function setRepeatWeekly(on: boolean) {
    setPostMode(on ? "weekly" : "date");
    if (on) {
      const iso = targetDate || serviceDate;
      if (iso) setDayOfWeek(weekdayFromISO(iso));
    }
  }

  const menuDate = targetDate || serviceDate;
  const repeatDow = menuDate ? weekdayFromISO(menuDate) : dayOfWeek;
  const menuEmpty = tab === "day" && menus.length === 0 && weeklyForDay.length === 0;

  if (err && !data) {
    return (
      <main className="cook-desk">
        <p className="err">{err}</p>
        <p className="muted">{t("cook.loginHint")}</p>
        <button type="button" className="btn sm" onClick={() => load()}>
          {t("common.retry")}
        </button>
      </main>
    );
  }

  if (!data) return <p className="muted">{t("cook.loading")}</p>;

  const mealLabel = mealTabs.find((m) => m.id === mealType)?.label ?? t("meal.lunch");
  const orders = data.orders ?? [];
  const queueCounts = {
    paid: orders.filter((o) => o.status === "PAID").length,
    cooking: orders.filter((o) => o.status === "COOKING").length,
    packed: orders.filter((o) => o.status === "PACKED").length,
    out: orders.filter(
      (o) =>
        o.status === "ASSIGNING_RIDER" ||
        o.status === "DISPATCHED" ||
        o.status === "DELAYED",
    ).length,
    done: orders.filter((o) => o.status === "DELIVERED").length,
  };

  return (
    <main className="cook-desk">
      <CookDeskHero
        slug={slug}
        kitchenName={data.cook.kitchenName}
        partnerActive={partnerActive || Boolean(data.delivery?.partnerActive)}
        cookMobile={data.whatsapp?.cookMobile ?? data.cook.mobileNumber ?? cookMobile}
        intakePaused={intakePaused}
        togglingPause={togglingPause}
        onTogglePause={() => void toggleIntakePause()}
        lateOrdersEnabled={lateOrdersEnabled}
        latePlatformEnabled={latePlatformEnabled}
        togglingLate={togglingLate}
        onToggleLate={() => void toggleLateOrders()}
      />

      <div className="seg desk-tabs" role="tablist" aria-label={t("cook.desk")}>
        <button
          type="button"
          role="tab"
          aria-selected={deskPanel === "run"}
          className={deskPanel === "run" ? "on" : ""}
          onClick={() => setDeskPanel("run")}
        >
          {t("cook.tabRun")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={deskPanel === "menu"}
          className={deskPanel === "menu" ? "on" : ""}
          onClick={() => setDeskPanel("menu")}
        >
          {t("cook.tabMenu")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={deskPanel === "reviews"}
          className={deskPanel === "reviews" ? "on" : ""}
          onClick={() => {
            setDeskPanel("reviews");
            loadReviews();
          }}
        >
          {t("cook.tabReviews")}
        </button>
      </div>

      <div className="seg meal-seg" style={{ margin: "0.65rem 0 0.9rem" }}>
        {mealTabs.map((m) => (
          <button
            key={m.id}
            type="button"
            className={mealType === m.id ? "on" : ""}
            onClick={() => setMealType(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {deskPanel === "run" ? (
        <>
          {data.earnings ? (
            <section className="cook-earnings" aria-label={t("cook.earnings")}>
              <div className="cook-earnings-head">
                <div>
                  <p className="cook-earnings-kicker">
                    {t("cook.earnings")} · {data.earnings.serviceDate}
                  </p>
                  <h2>{t("cook.foodPaid")}</h2>
                </div>
                <span
                  className={`chip cook-payout-chip tone-${
                    data.earnings.payout.status === "PAID"
                      ? "done"
                      : data.earnings.payout.status === "PENDING"
                        ? "warn"
                        : "neutral"
                  }`}
                >
                  {data.earnings.payout.label}
                </span>
              </div>
              <div className="cook-earnings-grid">
                <div className="cook-earn-stat">
                  <strong>₹{(data.earnings.meal.foodPaise / 100).toFixed(0)}</strong>
                  <span>
                    {t("cook.thisMeal")} · {t("cook.plates", { n: data.earnings.meal.plates })}
                  </span>
                </div>
                <div className="cook-earn-stat">
                  <strong>₹{(data.earnings.day.foodPaise / 100).toFixed(0)}</strong>
                  <span>
                    {t("cook.allDay")} · {t("cook.plates", { n: data.earnings.day.plates })}
                  </span>
                </div>
                <div className="cook-earn-stat">
                  <strong>₹{(data.earnings.day.deliveredFoodPaise / 100).toFixed(0)}</strong>
                  <span>
                    {t("cook.deliveredPicked")} · {data.earnings.day.deliveredPlates}
                  </span>
                </div>
              </div>
              {data.earnings.payout.detail ? (
                <p className="cook-earnings-detail">{data.earnings.payout.detail}</p>
              ) : null}
              {data.earnings.day.heldPlates > 0 ? (
                <p className="muted cook-earnings-hold">
                  {t("cook.onHold", { n: data.earnings.day.heldPlates })}
                </p>
              ) : null}
              {(data.earnings.day.clawbackPaise ?? 0) > 0 ? (
                <p className="muted cook-earnings-hold">
                  {t("cook.clawbackToday", {
                    amount: ((data.earnings.day.clawbackPaise ?? 0) / 100).toFixed(0),
                  })}
                </p>
              ) : null}
              {(data.earnings.day.pendingClawbackPaise ?? 0) > 0 ? (
                <p className="muted cook-earnings-hold">
                  {t("cook.clawbackPending", {
                    amount: ((data.earnings.day.pendingClawbackPaise ?? 0) / 100).toFixed(0),
                  })}
                </p>
              ) : null}
              <p className="muted cook-earnings-note">{data.earnings.note}</p>
            </section>
          ) : null}

          <section className="cook-run-summary" aria-label={t("cook.tabRun")}>
            <div className="cook-stat">
              <strong>{orders.length}</strong>
              <span>{t("cook.stops")}</span>
            </div>
            <div className="cook-stat">
              <strong>{queueCounts.paid}</strong>
              <span>{t("cook.toCook")}</span>
            </div>
            <div className="cook-stat">
              <strong>{queueCounts.cooking + queueCounts.packed}</strong>
              <span>{t("cook.inKitchen")}</span>
            </div>
            <div className="cook-stat">
              <strong>{queueCounts.out}</strong>
              <span>{t("cook.onRoad")}</span>
            </div>
            <div className="cook-stat">
              <strong>{cancelPending.length}</strong>
              <span>{t("cook.cancelRequests")}</span>
            </div>
            <div className="cook-stat">
              <strong>{latePending.length}</strong>
              <span>{t("cook.lateAsks")}</span>
            </div>
          </section>

          <section className="cook-upcoming" aria-label={t("cook.upcomingTitle")} style={{ marginBottom: "0.85rem" }}>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.05rem" }}>{t("cook.upcomingTitle")}</h2>
            <p className="muted" style={{ margin: "0 0 0.55rem", fontSize: "0.9rem" }}>
              {t("cook.upcomingHelp")}
            </p>
            {upcomingDays.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {t("cook.upcomingEmpty")}
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {upcomingDays.map((day) => {
                  const dateLabel = (() => {
                    const parts = day.serviceDate.split("-");
                    if (parts.length === 3) return `${parts[2]}/${parts[1]}`;
                    return day.serviceDate;
                  })();
                  return (
                    <li
                      key={`${day.serviceDate}-${day.mealType}`}
                      style={{
                        marginBottom: "0.55rem",
                        paddingBottom: "0.45rem",
                        borderBottom: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
                      }}
                    >
                      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                        <strong>
                          {day.dayLabel} {dateLabel}
                        </strong>
                        <span className="muted">
                          {t("cook.upcomingPlates", { n: String(day.totalPlates) })}
                          {day.mealType && day.mealType !== "LUNCH" ? ` · ${day.mealType}` : ""}
                        </span>
                      </div>
                      <p style={{ margin: "0.3rem 0 0", fontSize: "0.95rem" }}>
                        {day.lines.map((l) => `${l.qty}× ${l.itemName}`).join(" · ")}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {cancelPending.length > 0 ? (
            <section aria-label={t("cook.cancelRequests")} style={{ marginBottom: "0.85rem" }}>
              <h2 style={{ margin: "0 0 0.5rem" }}>{t("cook.cancelRequests")}</h2>
              {cancelPending.map((o) => (
                <div key={o.publicId} className="card" style={{ marginBottom: "0.55rem" }}>
                  <div className="row">
                    <strong>
                      {o.publicId} · {o.qty}× {o.itemName}
                    </strong>
                    <span className="chip tone-warn">{t("status.label.cancelRequested")}</span>
                  </div>
                  <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                    {o.serviceDate ? `${o.serviceDate} · ` : ""}
                    {o.customerMobile}
                  </p>
                  <p style={{ margin: "0.4rem 0 0", fontWeight: 650 }}>
                    {o.deliveryTargetAddress || t("cook.addressMissing")}
                  </p>
                  <div className="actions">
                    <button
                      className="btn"
                      type="button"
                      onClick={() => post(`/orders/${o.publicId}/cancel-accept`)}
                    >
                      {t("cook.acceptCancelRefund")}
                    </button>
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() =>
                        post(`/orders/${o.publicId}/cancel-decline`, {
                          reason: "Kitchen could not cancel — food is being prepared",
                        })
                      }
                    >
                      {t("cook.keepCooking")}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          <div className="cook-run-bar" aria-label={t("cook.tabRun")}>
            <button
              className="btn mustard"
              type="button"
              onClick={() => post(`/cooks/${slug}/cooking`, { mealType })}
            >
              {t("cook.batchCooking")}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => post(`/cooks/${slug}/pack`, { mealType })}
            >
              {t("cook.batchPacked")}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => post(`/cooks/${slug}/dispatch`, { mealType })}
            >
              {t("cook.batchDispatched")}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => post(`/internal/cutoffs/${mealType}`, { force: false })}
            >
              {t("cook.cutoff")}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => post("/internal/settlements/eod")}
            >
              {t("cook.eod")}
            </button>
          </div>
        </>
      ) : null}
      {deskPanel === "menu" ? (
        <>
      {mealType !== "LUNCH" ? (
        <p className="muted" style={{ marginTop: 0 }}>
          <label style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={mealEnabled}
              onChange={(e) => void toggleMealEnabled(e.target.checked)}
            />
            {t("cook.offerMeal", { meal: mealLabel })}
          </label>
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          {t("cook.lunchAlways")}
        </p>
      )}

      <details className="card cook-wa-feed">
        <summary>
          <strong>{t("cook.waToCook")}</strong>
          <span className="muted">{waFeed.length ? `${waFeed.length}` : t("cook.noWaEvents")}</span>
        </summary>
        {waFeed.length === 0 ? (
          <p className="muted">{t("cook.noWaEvents")}</p>
        ) : (
          waFeed.slice(0, 8).map((m) => (
            <div key={m.id} className="row" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <span className="chip">{m.eventName}</span>
                <p style={{ margin: "0.35rem 0 0", whiteSpace: "pre-wrap" }}>{m.preview}</p>
                <p className="muted" style={{ margin: 0 }}>
                  to {m.to}
                  {m.processedAt ? " · sent" : " · queued"}
                </p>
              </div>
            </div>
          ))
        )}
        <button className="btn sm secondary" type="button" onClick={loadWaFeed}>
          {t("cook.refreshWa")}
        </button>
      </details>

      <div className="card cook-menu-card">
        {err ? <p className="err cook-menu-banner">{err}</p> : null}
        {msg ? <p className="ok cook-menu-banner">{msg}</p> : null}
        <div className="cook-menu-head">
          <div>
            <p className="cook-menu-kicker">{mealLabel}</p>
            <h2 className="cook-menu-title">{t("cook.addPlate")}</h2>
          </div>
          <div className="seg cook-menu-seg" role="tablist" aria-label={mealLabel}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "day"}
              className={tab === "day" ? "on" : ""}
              onClick={() => switchMenuTab("day")}
            >
              {t("cook.byDay")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "week"}
              className={tab === "week" ? "on" : ""}
              onClick={() => switchMenuTab("week")}
            >
              {t("cook.weeklyPlan")}
            </button>
          </div>
        </div>

        {tab === "day" ? (
          <div className="cook-menu-daybar">
            <label className="cook-menu-date">
              <span>{t("cook.date")}</span>
              <input
                type="date"
                value={menuDate}
                onChange={(e) => setMenuDate(e.target.value)}
              />
            </label>
          </div>
        ) : null}

        <div className="cook-menu-list">
          {tab === "day" ? (
            menuEmpty ? (
              <div className="cook-menu-empty">
                <strong>{t("cook.nothingPosted")}</strong>
                <p className="muted">{t("cook.menuEmptyHint")}</p>
              </div>
            ) : (
              <>
                {menus.map(renderItem)}
                {weeklyForDay.length > 0 ? (
                  <>
                    <div className="cook-menu-subblock">
                      <p className="cook-menu-subhead">{t("cook.alsoWeekly")}</p>
                      <p className="cook-menu-subhint muted">{t("cook.alsoWeeklyHint")}</p>
                    </div>
                    {weeklyForDay.map(renderItem)}
                  </>
                ) : null}
              </>
            )
          ) : (
            <div className="cook-week-grid">
              {dayLabels.map((label, d) => {
                const plates = weekByDay[String(d)] ?? weekByDay[d] ?? [];
                return (
                  <button
                    key={d}
                    type="button"
                    className={`cook-week-day ${repeatDow === d ? "on" : ""}`}
                    onClick={() => {
                      setDayOfWeek(d);
                      setTab("week");
                    }}
                  >
                    <strong>{label}</strong>
                    {plates.length === 0 ? (
                      <span className="muted">{t("cook.nothingPosted")}</span>
                    ) : (
                      <span>{plates.map((p) => p.itemName).join(", ")}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="cook-saved-block">
          <div className="cook-add-plate-head">
            <strong>{t("cook.savedPlates")}</strong>
            <p className="muted">{t("cook.savedPlatesHint")}</p>
          </div>
          {savedPlates.length === 0 ? (
            <p className="muted cook-saved-empty">{t("cook.savedPlatesEmpty")}</p>
          ) : (
            <ul className="cook-saved-list">
              {savedPlates.map((p) => (
                <li key={p.id} className="cook-saved-row">
                  <div className="cook-saved-meta">
                    <strong>{p.itemName}</strong>
                    <span className="muted">
                      ₹{(p.pricePaise / 100).toFixed(0)}
                      {p.isVeg ? ` · ${t("cook.veg")}` : ""}
                    </span>
                  </div>
                  <div className="cook-saved-actions">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={postingSavedId === p.id}
                      onClick={() => void postSavedPlate(p.id)}
                    >
                      {postingSavedId === p.id ? t("cook.sending") : t("cook.addSavedToDate")}
                    </button>
                    <button
                      type="button"
                      className="cook-plate-link cook-plate-link-danger"
                      onClick={() => void removeSavedPlate(p.id, p.itemName)}
                    >
                      {t("cook.removeSaved")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="cook-saved-block">
          <div className="cook-add-plate-head">
            <strong>{t("cook.templates")}</strong>
            <p className="muted">{t("cook.templatesHint")}</p>
          </div>
          <label className="cook-add-field">
            <span>{t("cook.templateName")}</span>
            <input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder={t("cook.templateNamePlaceholder")}
              maxLength={80}
            />
          </label>
          <button
            type="button"
            className="btn sm"
            disabled={!templateName.trim()}
            onClick={() => void saveTemplateFromDay()}
          >
            {t("cook.saveTemplateFromDay")}
          </button>
          {menuTemplates.length === 0 ? (
            <p className="muted cook-saved-empty">{t("cook.templatesEmpty")}</p>
          ) : (
            <ul className="cook-saved-list">
              {menuTemplates.map((tpl) => (
                <li key={tpl.id} className="cook-saved-row">
                  <div className="cook-saved-meta">
                    <strong>{tpl.name}</strong>
                    <span className="muted">{tpl.itemCount} plates</span>
                  </div>
                  <div className="cook-saved-actions">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={postingTemplateId === tpl.id}
                      onClick={() => void postMenuTemplate(tpl.id)}
                    >
                      {postingTemplateId === tpl.id ? t("cook.sending") : t("cook.postTemplate")}
                    </button>
                    <button
                      type="button"
                      className="cook-plate-link cook-plate-link-danger"
                      onClick={() => void removeMenuTemplate(tpl.id, tpl.name)}
                    >
                      {t("cook.removeTemplate")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="cook-add-plate">
          <div className="cook-add-plate-head">
            <strong>{t("cook.addPlate")}</strong>
            <p className="muted">
              {postMode === "date"
                ? t("cook.postingForDate", { date: menuDate || "—" })
                : t("cook.repeatWeeklyHint", { day: dayLabels[repeatDow] ?? "—" })}
            </p>
          </div>

          <label className="cook-add-field">
            <span>{t("cook.date")}</span>
            <input
              type="date"
              value={menuDate}
              onChange={(e) => {
                setMenuDate(e.target.value);
                setTab("day");
              }}
            />
          </label>

          <button
            type="button"
            className={`cook-toggle cook-repeat-toggle ${postMode === "weekly" ? "on" : ""}`}
            role="switch"
            aria-checked={postMode === "weekly"}
            onClick={() => setRepeatWeekly(postMode !== "weekly")}
          >
            <span className="cook-toggle-knob" aria-hidden />
            <span className="cook-toggle-text">
              {t("cook.repeatWeekly")}
              {postMode === "weekly" ? ` · ${dayLabels[repeatDow]}` : ""}
            </span>
          </button>

          <div className="cook-add-fields">
            <label className="cook-add-field">
              <span>{t("cook.itemName")}</span>
              <input
                type="text"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="cook-add-field">
              <span>{t("cook.itemNameTa")}</span>
              <input
                type="text"
                value={itemNameTa}
                onChange={(e) => setItemNameTa(e.target.value)}
                autoComplete="off"
              />
            </label>
          </div>

          <div className="cook-add-meta">
            <label className="cook-add-field cook-add-price">
              <span>{t("cook.price")}</span>
              <span className="cook-price-input">
                <span aria-hidden>₹</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={priceRupees}
                  onChange={(e) => setPriceRupees(e.target.value)}
                />
              </span>
            </label>
            <label className="cook-veg-toggle">
              <input type="checkbox" checked={isVeg} onChange={(e) => setIsVeg(e.target.checked)} />
              <span>{t("cook.veg")}</span>
            </label>
          </div>

          <label className="cook-veg-toggle cook-save-library-toggle">
            <input
              type="checkbox"
              checked={saveToLibrary}
              onChange={(e) => setSaveToLibrary(e.target.checked)}
            />
            <span>{t("cook.saveToLibrary")}</span>
          </label>

          <div className="cook-add-actions">
            <label className="btn secondary cook-add-photo-btn">
              {photoFile ? photoFile.name.slice(0, 22) : t("cook.addPhoto")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif"
                className="cook-file-input"
                onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <button
              className="btn"
              type="button"
              disabled={savingMenu || !itemName.trim() || !Number(priceRupees)}
              onClick={addMenuItem}
            >
              {savingMenu ? t("cook.sending") : t("cook.addItem")}
            </button>
          </div>
        </div>
      </div>

      <CookSettingsCards
        mealLabel={mealLabel}
        lunchCutoff={data.lunchCutoff}
        deliveryWindow={data.deliveryWindow}
        hour={hour}
        minute={minute}
        onHourChange={setHour}
        onMinuteChange={setMinute}
        onSaveCutoff={saveCutoff}
        winStartH={winStartH}
        winStartM={winStartM}
        winEndH={winEndH}
        winEndM={winEndM}
        onWinStartHChange={setWinStartH}
        onWinStartMChange={setWinStartM}
        onWinEndHChange={setWinEndH}
        onWinEndMChange={setWinEndM}
        onSaveDeliveryWindow={saveDeliveryWindow}
        weekPct={weekPct}
        weekMinDays={weekMinDays}
        weekPlatformOn={weekPlatformOn}
        onWeekPctChange={setWeekPct}
        onWeekMinDaysChange={setWeekMinDays}
        onSaveWeekDiscount={saveWeekDiscount}
        offerCookDelivery={offerCookDelivery}
        pickupOn={pickupOn}
        pickupPlatformOn={pickupPlatformOn}
        offerCustomerArrange={offerCustomerArrange}
        pickupLandmark={pickupLandmark}
        savingFulfillment={savingFulfillment}
        savingPickup={savingPickup}
        onToggleOfferCookDelivery={() => setOfferCookDelivery((v) => !v)}
        onTogglePickup={() => setPickupOn((v) => !v)}
        onToggleOfferCustomerArrange={() => setOfferCustomerArrange((v) => !v)}
        onPickupLandmarkChange={setPickupLandmark}
        onSaveFulfillmentOffers={() => void saveFulfillmentOffers()}
        partnerActive={partnerActive}
        deliveryType={deliveryType}
        partnerPlatformOn={partnerPlatformOn}
        adsEnabled={adsEnabled}
        boostBusy={boostBusy}
        boostCampaigns={boostCampaigns}
        onRequestBoost={() => void requestBoost()}
      />
        </>
      ) : null}

      {deskPanel === "run" ? (
        <>
      {data.lock ? (
        <div className="card">
          <strong>
            {t("cook.manifestLocked")} · {t("cook.plates", { n: data.lock.headcount })}
          </strong>
          {data.lock.routeMapsUrl ? (
            <p>
              <a className="btn sm" href={data.lock.routeMapsUrl} target="_blank" rel="noreferrer">
                {t("cook.openRoute")}
              </a>
            </p>
          ) : null}
          <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
            {groupCookStops(
              orders.filter((o) => !["DELIVERED", "REFUNDED", "CANCELLED"].includes(o.status)),
            ).map((stop: DeskStop) => (
              <li key={stop.key} style={{ marginBottom: "0.35rem" }}>
                <strong>
                  {stop.orders.length > 1
                    ? `${stop.totalQty} plates · ${stop.orders.length} orders`
                    : stop.orders[0].publicId}
                </strong>{" "}
                — {stop.deliveryTargetAddress || t("cook.noAddress")}
                {stop.orders.length > 1 ? (
                  <span className="muted">
                    {" "}
                    ({stop.orders.map((o: ManifestOrder) => o.publicId).join(", ")})
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="muted">{t("cook.noLock")}</p>
      )}

      <h2 style={{ marginTop: "1.2rem" }}>{t("cook.lateRequests")}</h2>
      {latePending.length === 0 ? (
        <p className="muted">{t("cook.noLatePending")}</p>
      ) : (
        latePending.map((o) => (
          <div key={o.id} className="card">
            <div className="row">
              <strong>
                {o.publicId} · {o.qty}× {o.itemName}
              </strong>
              <span className="chip">PENDING</span>
            </div>
            <p style={{ margin: "0.45rem 0 0.15rem", fontWeight: 650 }}>
              📍 {o.deliveryTargetAddress || t("cook.addressMissing")}
            </p>
            <p className="muted" style={{ margin: 0 }}>
              {o.customerMobile} · spice {o.spice}
            </p>
            <div className="actions">
              <button
                className="btn sm"
                type="button"
                onClick={() => post(`/orders/${o.publicId}/late-approve`)}
              >
                {t("cook.acceptPay")}
              </button>
              <button
                className="btn sm secondary"
                type="button"
                onClick={() =>
                  post(`/orders/${o.publicId}/late-decline`, {
                    reason: "Kitchen at capacity for late lunch",
                  })
                }
              >
                {t("cook.decline")}
              </button>
            </div>
          </div>
        ))
      )}

      <h2 style={{ marginTop: "1.2rem" }}>{t("cook.mealDeliveries", { meal: mealLabel })}</h2>
      {orders.length === 0 ? (
        <div className="card empty-card">
          <p className="muted">{t("cook.noPaidOrders", { meal: mealLabel })}</p>
        </div>
      ) : null}
      {groupCookStops(
        [...orders].sort(
          (a, b) =>
            Number(b.status === "CANCEL_REQUESTED") - Number(a.status === "CANCEL_REQUESTED"),
        ),
      ).map((stop: DeskStop, i: number) => {
        const fulfillmentMode = stop.fulfillmentMode;
        const partnerOrder = stop.orders.some(
          (o: ManifestOrder) =>
            o.logisticsMode === "PARTNER" || o.status === "ASSIGNING_RIDER",
        );
        const multi = stop.orders.length > 1;
        return (
          <div key={stop.key} className="card cook-stop">
            <div className="row" style={{ borderBottom: 0 }}>
              <strong>
                {multi
                  ? t("cook.stopGrouped", {
                      n: i + 1,
                      plates: stop.totalQty,
                      orders: stop.orders.length,
                    })
                  : `${t("cook.stop", { n: i + 1 })} · ${stop.orders[0].qty}× ${stop.orders[0].itemName}`}
                {fulfillmentMode === "PICKUP" ? ` · ${t("cook.pickup")}` : ""}
                {partnerOrder ? ` · ${t("cook.partnerDelivery")}` : ""}
              </strong>
            </div>
            <p className="cook-stop-addr">
              {fulfillmentMode === "PICKUP"
                ? stop.deliveryTargetAddress || t("cook.pickup")
                : stop.deliveryTargetAddress || t("cook.addressMissing")}
            </p>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              {stop.customerMobile}
              {fulfillmentMode === "PICKUP" ? ` · ${t("cook.showCode")}` : ""}
            </p>
            {stop.orders.map((o: ManifestOrder) => {
              const next = cookNextAction(t, o.status, o.fulfillmentMode);
              const cancelAsk = o.status === "CANCEL_REQUESTED";
              const linePartner =
                o.logisticsMode === "PARTNER" || o.status === "ASSIGNING_RIDER";
              return (
                <div
                  key={o.id}
                  style={{
                    marginTop: "0.65rem",
                    paddingTop: multi ? "0.55rem" : 0,
                    borderTop: multi ? "1px solid var(--line)" : undefined,
                  }}
                >
                  <div className="row" style={{ borderBottom: 0 }}>
                    <strong style={{ fontWeight: 600 }}>
                      {o.qty}× {o.itemName}
                      {o.spice === "LESS" ? " · less spicy" : ""}
                    </strong>
                    <span className={`chip tone-${statusTone(o.status)}`}>
                      {customerStatusLabel(t, o.status, {
                        fulfillmentMode: o.fulfillmentMode,
                      })}
                    </span>
                  </div>
                  <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.8rem" }}>
                    {o.publicId}
                  </p>
                  {linePartner && o.partnerShipmentId ? (
                    <p className="cook-partner-ship" style={{ margin: "0.25rem 0 0" }}>
                      <span className="chip tone-progress">
                        {t("cook.shipment")} · {o.partnerShipmentId}
                      </span>
                      {o.partnerTrackingUrl ? (
                        <>
                          {" "}
                          <a href={o.partnerTrackingUrl} target="_blank" rel="noreferrer">
                            {t("cook.trackRider")}
                          </a>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  <div className="actions cook-stop-actions">
                    {cancelAsk ? (
                      <>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => post(`/orders/${o.publicId}/cancel-accept`)}
                        >
                          {t("cook.acceptCancelRefund")}
                        </button>
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() =>
                            post(`/orders/${o.publicId}/cancel-decline`, {
                              reason: "Kitchen could not cancel — food is being prepared",
                            })
                          }
                        >
                          {t("cook.keepCooking")}
                        </button>
                      </>
                    ) : next ? (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => post(`/orders/${o.publicId}/${next.pathSuffix}`)}
                      >
                        {next.label}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {fulfillmentMode !== "PICKUP" && stop.deliveryTargetAddress ? (
              <div className="actions cook-stop-actions" style={{ marginTop: "0.5rem" }}>
                <a
                  className="btn secondary"
                  href={mapsLinkForAddress(stop.deliveryTargetAddress)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("cook.maps")}
                </a>
              </div>
            ) : null}
          </div>
        );
      })}
        </>
      ) : null}

      {deskPanel === "reviews" ? (
        <section className="cook-reviews" aria-label={t("cook.customerReviews")}>
          <header className="cook-reviews-hero">
            <p className="cook-menu-kicker">{t("cook.reviewsBlurb")}</p>
            <h2>{t("cook.customerReviews")}</h2>
            <p className="cook-reviews-soft">{t("cook.reviewsSoftLaunch", { n: reviewSoftMin })}</p>
            <div className="cook-reviews-stats">
              <div className="cook-earn-stat">
                <strong>
                  {reviewSummary?.average != null
                    ? `★ ${reviewSummary.average.toFixed(1)}`
                    : "—"}
                </strong>
                <span>{t("cook.avgRating")}</span>
              </div>
              <div className="cook-earn-stat">
                <strong>{reviewSummary?.count ?? 0}</strong>
                <span>{t("cook.reviewsCount", { n: reviewSummary?.count ?? 0 })}</span>
              </div>
              <div className="cook-earn-stat">
                <strong>
                  {reviewSummary?.public
                    ? t("cook.on")
                    : `${reviewSummary?.count ?? 0}/${reviewSoftMin}`}
                </strong>
                <span>
                  {reviewSummary?.public
                    ? t("cook.publicLive")
                    : t("cook.reviewsHiddenPublic", {
                        have: reviewSummary?.count ?? 0,
                        need: reviewSoftMin,
                      })}
                </span>
              </div>
            </div>
          </header>

          {deskReviews.length === 0 ? (
            <div className="cook-menu-empty">
              <strong>{t("cook.noReviews")}</strong>
              <p className="muted">{t("cook.reviewsSoftLaunch", { n: reviewSoftMin })}</p>
            </div>
          ) : (
            <div className="cook-reviews-list">
              {deskReviews.map((r) => {
                const editing = replyEditing[r.id] || !r.cookReply;
                return (
                  <article key={r.id} className="card cook-review-card">
                    <div className="cook-review-top">
                      <span className="review-stars" aria-label={`${r.rating} stars`}>
                        {"★".repeat(r.rating)}
                        <span className="review-stars-empty">{"★".repeat(5 - r.rating)}</span>
                      </span>
                      <span className="chip">{r.orderPublicId}</span>
                    </div>
                    <p className="cook-review-meta muted">
                      {r.customerLabel} · {r.itemName} · {r.serviceDate}
                    </p>
                    {r.comment ? <p className="cook-review-comment">{r.comment}</p> : null}
                    {r.cookReply && !editing ? (
                      <div className="cook-review-reply-block">
                        <p className="review-cook-reply">
                          <strong>{t("cook.yourReply")}</strong> {r.cookReply}
                        </p>
                        <button
                          className="btn sm secondary"
                          type="button"
                          onClick={() => {
                            setReplyDraft((d) => ({ ...d, [r.id]: r.cookReply ?? "" }));
                            setReplyEditing((d) => ({ ...d, [r.id]: true }));
                          }}
                        >
                          {t("cook.editReply")}
                        </button>
                      </div>
                    ) : (
                      <div className="cook-review-compose">
                        <input
                          type="text"
                          placeholder={t("cook.replyPlaceholder")}
                          value={replyDraft[r.id] ?? ""}
                          maxLength={500}
                          onChange={(e) =>
                            setReplyDraft((d) => ({ ...d, [r.id]: e.target.value }))
                          }
                        />
                        <button
                          className="btn sm"
                          type="button"
                          disabled={replyBusy === r.id || !(replyDraft[r.id] ?? "").trim()}
                          onClick={() => sendReply(r.id)}
                        >
                          {replyBusy === r.id ? t("cook.sending") : t("cook.reply")}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      <section className="card" style={{ marginTop: "1.5rem" }}>
        <h2>Report an issue</h2>
        <p className="muted">Ops gets a WhatsApp alert. Include an order id when it helps.</p>
        <CookReportIssue slug={slug} />
      </section>

      {err ? <pre className="err">{err}</pre> : null}
      {msg ? <pre className="ok">{msg}</pre> : null}
    </main>
  );
}

function CookReportIssue({ slug }: { slug: string }) {
  const [summary, setSummary] = useState("");
  const [orderPublicId, setOrderPublicId] = useState("");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [localOk, setLocalOk] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setLocalErr(null);
    setLocalOk(null);
    try {
      const res = await authFetch(`/cooks/${slug}/tickets`, {
        method: "POST",
        body: JSON.stringify({
          summary: summary.trim(),
          orderPublicId: orderPublicId.trim() || null,
          category: "COOK_OPS",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not submit");
      setLocalOk(`Ticket #${json.ticketId} opened`);
      setSummary("");
      setOrderPublicId("");
    } catch (e) {
      setLocalErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: "0.75rem" }}>
      <label className="order-field">
        What happened
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          placeholder="Short description (min 10 characters)"
          disabled={busy}
        />
      </label>
      <label className="order-field">
        Order id (optional)
        <input
          type="text"
          value={orderPublicId}
          onChange={(e) => setOrderPublicId(e.target.value)}
          placeholder="LM-…"
          disabled={busy}
        />
      </label>
      <button
        className="btn sm"
        type="button"
        disabled={busy || summary.trim().length < 10}
        onClick={() => void submit()}
      >
        {busy ? "Sending…" : "Send to ops"}
      </button>
      {localErr ? <p className="err">{localErr}</p> : null}
      {localOk ? <p className="ok">{localOk}</p> : null}
    </div>
  );
}

export default function CookDeskPage() {
  return (
    <RequireAuth role="COOK">
      <CookDeskInner />
    </RequireAuth>
  );
}
