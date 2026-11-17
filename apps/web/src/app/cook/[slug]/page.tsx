"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { API_BASE } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import { cookNextAction, customerStatusLabel, statusTone } from "@/lib/orderStatus";
import type { MsgKey } from "@localmeals/i18n";

type CookEarnings = {
  serviceDate: string;
  note: string;
  meal: { mealType: string; plates: number; foodPaise: number };
  day: {
    plates: number;
    foodPaise: number;
    deliveredPlates: number;
    deliveredFoodPaise: number;
    heldPlates: number;
    pendingClawbackPaise?: number;
    clawbackPaise?: number;
  };
  payout: {
    status: string;
    label: string;
    detail: string | null;
    netPaise: number | null;
    orderCount: number | null;
    manualPaidAt: string | null;
    manualUtr: string | null;
    settlementStatus: string | null;
    clawbackPaise?: number;
  };
};

type Manifest = {
  cook: { kitchenName: string; id: string; mobileNumber?: string };
  lunchCutoff?: string;
  deliveryWindow?: string;
  deliveryWindowParts?: {
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
  };
  whatsapp?: { cookMobile: string; note: string };
  lock: { headcount: number; routeMapsUrl: string | null } | null;
  earnings?: CookEarnings;
  orders: Array<{
    id: number;
    publicId: string;
    itemName: string;
    qty: number;
    spice: string;
    status: string;
    customerMobile: string;
    deliveryTargetAddress: string;
    fulfillmentMode?: string | null;
    routeMapsUrl?: string | null;
  }>;
};

type WaFeedItem = {
  id: number;
  eventName: string;
  preview: string;
  to: string;
  processedAt: string | null;
  createdAt: string;
};

type DeskReview = {
  id: number;
  rating: number;
  comment: string | null;
  cookReply: string | null;
  createdAt: string;
  customerLabel: string;
  orderPublicId: string;
  itemName: string;
  serviceDate: string;
};

function mapsLinkForAddress(address: string) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

type MenuItem = {
  id: number;
  itemName: string;
  itemNameTa?: string | null;
  pricePaise: number;
  isVeg: boolean;
  isAvailable: boolean;
  allergens: string[];
  serviceDate: string | null;
  dayOfWeek: number | null;
  imageUrl: string | null;
  totalStockAvailable: number;
};

const DAY_KEYS = [
  "day.sun",
  "day.mon",
  "day.tue",
  "day.wed",
  "day.thu",
  "day.fri",
  "day.sat",
] as const satisfies readonly MsgKey[];
type MealType = "BREAKFAST" | "LUNCH" | "DINNER";
const MEAL_IDS: MealType[] = ["BREAKFAST", "LUNCH", "DINNER"];
const MEAL_KEYS: Record<MealType, MsgKey> = {
  BREAKFAST: "meal.breakfast",
  LUNCH: "meal.lunch",
  DINNER: "meal.dinner",
};

function imgSrc(url: string | null | undefined) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_BASE}${url}`;
}

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
  const [savingPickup, setSavingPickup] = useState(false);

  const [itemName, setItemName] = useState("");
  const [itemNameTa, setItemNameTa] = useState("");
  const [priceRupees, setPriceRupees] = useState("80");
  const [isVeg, setIsVeg] = useState(true);
  const [targetDate, setTargetDate] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [postMode, setPostMode] = useState<"date" | "weekly">("date");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
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

  const loadKitchenExtras = useCallback(() => {
    authFetch(`/cooks/${slug}/meal-settings`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) return;
        if (json.weekDiscount) {
          setWeekPct(json.weekDiscount.percent ?? 0);
          setWeekMinDays(json.weekDiscount.minDays ?? 3);
          setWeekPlatformOn(json.weekDiscount.platformEnabled !== false);
        }
        if (json.pickup) {
          setPickupOn(Boolean(json.pickup.enabled));
          setPickupLandmark(json.pickup.landmark ?? "");
          setPickupPlatformOn(Boolean(json.pickup.platformEnabled));
        }
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
  }, [
    slug,
    user,
    loadMenu,
    loadWaFeed,
    loadLatePending,
    loadCancelPending,
    loadSavedPlates,
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
      return n > 0 ? t("cook.dispatched", { n }) : t("cook.done");
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
    const fd = new FormData();
    fd.append("file", photoFile);
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
    try {
      const fd = new FormData();
      fd.append("file", file);
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
      loadMenu(tab, targetDate || undefined);
    } catch (e) {
      setErr((e as Error).message);
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
            <label className="cook-plate-link">
              {t("cook.photo")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                hidden
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
    out: orders.filter((o) => o.status === "DISPATCHED" || o.status === "DELAYED").length,
    done: orders.filter((o) => o.status === "DELIVERED").length,
  };

  return (
    <main className="cook-desk">
      <header className="cook-hero">
        <p className="chip">{t("cook.desk")}</p>
        <h1>{data.cook.kitchenName}</h1>
        <p className="muted">
          {t("cook.selfDelivery")} · WA →{" "}
          <strong>{data.whatsapp?.cookMobile ?? data.cook.mobileNumber ?? cookMobile}</strong>
        </p>
      </header>

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
                accept="image/jpeg,image/png,image/webp,image/gif"
                hidden
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

      <h2 style={{ marginTop: "0.5rem" }}>{t("cook.kitchenSettings")}</h2>

      <div className="card cook-settings-card">
        <div className="cook-setting-row">
          <div className="cook-setting-copy">
            <strong>
              {mealLabel} · {t("cook.cutoff")}
            </strong>
            <span className="muted">{data.lunchCutoff ?? "08:00"}</span>
          </div>
          <div className="cook-setting-controls">
            <label className="cook-time-field">
              <span className="cook-time-label">{t("cook.cutoff")}</span>
              <div className="cook-time-pair">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={String(hour).padStart(2, "0")}
                  onChange={(e) => setHour(Number(e.target.value))}
                  aria-label="Hour"
                />
                <span aria-hidden>:</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={String(minute).padStart(2, "0")}
                  onChange={(e) => setMinute(Number(e.target.value))}
                  aria-label="Minute"
                />
              </div>
            </label>
            <button className="btn sm cook-setting-save" type="button" onClick={saveCutoff}>
              {t("cook.save")}
            </button>
          </div>
        </div>

        <div className="cook-setting-row">
          <div className="cook-setting-copy">
            <strong>
              {mealLabel} · {t("cook.deliveryEta")}
            </strong>
            <span className="muted">{data.deliveryWindow ?? "12:00–13:00"}</span>
          </div>
          <div className="cook-setting-controls cook-setting-controls-eta">
            <label className="cook-time-field">
              <span className="cook-time-label">{t("cook.from")}</span>
              <div className="cook-time-pair">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={String(winStartH).padStart(2, "0")}
                  onChange={(e) => setWinStartH(Number(e.target.value))}
                  aria-label="Start hour"
                />
                <span aria-hidden>:</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={String(winStartM).padStart(2, "0")}
                  onChange={(e) => setWinStartM(Number(e.target.value))}
                  aria-label="Start minute"
                />
              </div>
            </label>
            <label className="cook-time-field">
              <span className="cook-time-label">{t("cook.to")}</span>
              <div className="cook-time-pair">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={String(winEndH).padStart(2, "0")}
                  onChange={(e) => setWinEndH(Number(e.target.value))}
                  aria-label="End hour"
                />
                <span aria-hidden>:</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={String(winEndM).padStart(2, "0")}
                  onChange={(e) => setWinEndM(Number(e.target.value))}
                  aria-label="End minute"
                />
              </div>
            </label>
            <button
              className="btn sm cook-setting-save"
              type="button"
              onClick={saveDeliveryWindow}
            >
              {t("cook.saveEta")}
            </button>
          </div>
        </div>
      </div>

      <div className="card cook-pref-card">
        <div className="cook-pref-head">
          <div>
            <p className="cook-menu-kicker">{t("cook.kitchenSettings")}</p>
            <strong>{t("cook.weekDiscount")}</strong>
          </div>
          <span className={`chip ${weekPct > 0 ? "tone-done" : "tone-neutral"}`}>
            {weekPct > 0 ? `${weekPct}%` : t("cook.off")}
          </span>
        </div>
        <p className="cook-pref-help">{t("cook.weekDiscountHelp")}</p>
        {!weekPlatformOn ? (
          <p className="cook-pref-banner">{t("cook.weekDiscountPaused")}</p>
        ) : null}
        <div className="cook-pref-controls">
          <label className="cook-pref-field">
            <span className="cook-time-label">%</span>
            <div className="cook-pref-input">
              <input
                type="number"
                min={0}
                max={15}
                value={weekPct}
                onChange={(e) => setWeekPct(Number(e.target.value))}
              />
            </div>
          </label>
          <label className="cook-pref-field">
            <span className="cook-time-label">{t("cook.minDays")}</span>
            <div className="cook-pref-input">
              <input
                type="number"
                min={2}
                max={14}
                value={weekMinDays}
                onChange={(e) => setWeekMinDays(Number(e.target.value))}
              />
            </div>
          </label>
          <button className="btn sm cook-setting-save" type="button" onClick={saveWeekDiscount}>
            {t("cook.save")}
          </button>
        </div>
      </div>

      <div className="card cook-pref-card">
        <div className="cook-pref-head">
          <div>
            <p className="cook-menu-kicker">{t("cook.pickupSettings")}</p>
            <strong>{t("cook.pickupOffer")}</strong>
          </div>
          <span className={`chip ${pickupOn ? "tone-done" : "tone-neutral"}`}>
            {pickupOn ? t("cook.on") : t("cook.off")}
          </span>
        </div>
        <p className="cook-pref-help">{t("cook.pickupHelp")}</p>
        {!pickupPlatformOn ? (
          <p className="cook-pref-banner">{t("cook.pickupPlatformOff")}</p>
        ) : null}
        <button
          type="button"
          className={`cook-toggle ${pickupOn ? "on" : ""}`}
          role="switch"
          aria-checked={pickupOn}
          disabled={!pickupPlatformOn}
          onClick={() => setPickupOn((v) => !v)}
        >
          <span className="cook-toggle-knob" aria-hidden />
          <span className="cook-toggle-text">
            {pickupOn ? t("cook.on") : t("cook.off")}
          </span>
        </button>
        <label className="cook-pref-field cook-pref-field-full">
          <span className="cook-time-label">{t("cook.pickupLandmark")}</span>
          <input
            className="cook-pref-text"
            type="text"
            value={pickupLandmark}
            maxLength={300}
            placeholder={t("cook.pickupLandmarkPlaceholder")}
            onChange={(e) => setPickupLandmark(e.target.value)}
          />
        </label>
        <button
          className="btn cook-setting-save cook-pref-save"
          type="button"
          disabled={savingPickup}
          onClick={savePickupSettings}
        >
          {savingPickup ? t("cook.sending") : t("cook.save")}
        </button>
      </div>
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
            {orders
              .filter((o) => !["DELIVERED", "REFUNDED", "CANCELLED"].includes(o.status))
              .map((o) => (
                <li key={o.id} style={{ marginBottom: "0.35rem" }}>
                  <strong>{o.publicId}</strong> — {o.deliveryTargetAddress || t("cook.noAddress")}
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
      {[...orders]
        .sort((a, b) => Number(b.status === "CANCEL_REQUESTED") - Number(a.status === "CANCEL_REQUESTED"))
        .map((o, i) => {
        const fulfillmentMode = o.fulfillmentMode;
        const next = cookNextAction(t, o.status, fulfillmentMode);
        const cancelAsk = o.status === "CANCEL_REQUESTED";
        return (
          <div key={o.id} className="card cook-stop">
            <div className="row" style={{ borderBottom: 0 }}>
              <strong>
                {t("cook.stop", { n: i + 1 })} · {o.qty}× {o.itemName}
                {fulfillmentMode === "PICKUP" ? ` · ${t("cook.pickup")}` : ""}
              </strong>
              <span className={`chip tone-${statusTone(o.status)}`}>
                {customerStatusLabel(t, o.status, { fulfillmentMode })}
              </span>
            </div>
            <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.8rem" }}>
              {o.publicId}
              {fulfillmentMode === "PICKUP" ? ` · ${t("cook.showCode")}` : ""}
            </p>
            <p className="cook-stop-addr">
              {fulfillmentMode === "PICKUP"
                ? o.deliveryTargetAddress || t("cook.pickup")
                : o.deliveryTargetAddress || t("cook.addressMissing")}
            </p>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              {o.customerMobile} · spice {o.spice}
            </p>
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
              {!cancelAsk && fulfillmentMode !== "PICKUP" && o.deliveryTargetAddress ? (
                <a
                  className="btn secondary"
                  href={mapsLinkForAddress(o.deliveryTargetAddress)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("cook.maps")}
                </a>
              ) : null}
            </div>
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

      {err ? <pre className="err">{err}</pre> : null}
      {msg ? <pre className="ok">{msg}</pre> : null}
    </main>
  );
}

export default function CookDeskPage() {
  return (
    <RequireAuth role="COOK">
      <CookDeskInner />
    </RequireAuth>
  );
}
