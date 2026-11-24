"use client";

import { uploadSrc } from "@/lib/uploadUrl";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  CheckoutAddressPicker,
  type SavedAddress,
} from "@/components/CheckoutAddressPicker";
import { useLocale } from "@/components/LocaleProvider";
import { API_BASE } from "@/lib/api";
import { authFetch, loginPath } from "@/lib/auth";
import { FulfillmentChooser } from "@/components/FulfillmentChooser";
import { flagOn, useFeatureFlags } from "@/lib/features";
import {
  needsCheckoutAddress,
  resolveEffectiveFulfillment,
  type FulfillmentMode,
} from "@/lib/fulfillment";
import { resolveSelfDeliveryPaise } from "@/lib/deliveryDistance";
import { isExternalPaymentUrl, payPageHref } from "@/lib/payments";
import { isSoloKitchenMode, platformFeePaise } from "@/lib/soloKitchen";
import { localizedDishName } from "@localmeals/i18n";
import { OrderForm, type CartAddPayload } from "./OrderForm";
import {
  ConfirmPayDialog,
  type ConfirmPayChoice,
  type ConfirmPaySummary,
} from "@/components/ConfirmPayDialog";

type MealType = "BREAKFAST" | "LUNCH" | "DINNER";

type MenuItem = {
  id: number;
  itemName: string;
  itemNameTa?: string | null;
  pricePaise: number;
  isVeg: boolean;
  portionNote?: string | null;
  allergens?: string[] | null;
  imageUrl?: string | null;
  serviceDate?: string | null;
  dayOfWeek?: number | null;
};

type DayPlan = {
  serviceDate: string;
  dayOfWeek: number;
  dayLabel: string;
  isToday: boolean;
  orderingOpen: boolean;
  lateOrderingOpen?: boolean;
  itemCount: number;
  menus: MenuItem[];
};

export type KitchenWeekPayload = {
  cook: {
    kitchenName: string;
    slugHandle: string;
    fssaiNumber: string | null;
    flatSelfDeliveryFee?: string | number;
    deliveryType?: string | null;
    lat?: string | number | null;
    lng?: string | number | null;
  };
  mealType?: MealType;
  mealLabel?: string;
  mealEnabled?: boolean;
  lunchCutoff?: string;
  cutoff?: string;
  deliveryWindow?: string;
  orderingOpen?: boolean;
  lateOrdersEnabled?: boolean;
  /** True when late-ask timing window is open (AND with lateOrdersEnabled). */
  lateOrderingOpen?: boolean;
  intakePaused?: boolean;
  nextServiceDate?: string | null;
  openStatusLabel?: string;
  fulfillmentOffers?: {
    cookDelivery?: boolean;
    pickup?: boolean;
    customerArrange?: boolean;
  };
  pickup?: { available: boolean; window: string; hint: string | null };
  plan: DayPlan[];
  weekDiscount?: { percent: number; minDays: number; label: string | null };
  reviews?: { average: number | null; count: number; public: boolean };
};

type WeekPayload = KitchenWeekPayload;

type PublicReview = {
  id: number;
  rating: number;
  comment: string | null;
  cookReply: string | null;
  createdAt: string;
  customerLabel: string;
};

type CartLine = CartAddPayload & { mealType: MealType; mealLabel: string };

const imgSrc = uploadSrc;

export function KitchenBrowse({
  slug,
  initialWeek = null,
}: {
  slug: string;
  /** SSR prefetch of lunch week plan — skips first client spinner when present. */
  initialWeek?: WeekPayload | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { t, locale } = useLocale();
  const flags = useFeatureFlags();
  const childPaysOn = flagOn(flags, "child_pays_enabled");
  const followOn = flagOn(flags, "kitchen_follow_enabled");
  const reviewsOn = flagOn(flags, "reviews_enabled");
  const distanceLimitsOn = flagOn(flags, "delivery_distance_limits_enabled");
  const selfDeliveryFeeOn = flagOn(flags, "self_delivery_fee_enabled");

  const mealParam = (searchParams.get("meal") ?? "").trim().toUpperCase();
  const afterDate = searchParams.get("after");
  const againMode = searchParams.get("again") === "1" || Boolean(afterDate);

  const MEALS: { id: MealType; label: string }[] = [
    { id: "BREAKFAST", label: t("meal.breakfast") },
    { id: "LUNCH", label: t("meal.lunch") },
    { id: "DINNER", label: t("meal.dinner") },
  ];

  function formatDayTitle(day: DayPlan) {
    const [, m, d] = day.serviceDate.split("-");
    const when = day.isToday ? t("common.today") : day.dayLabel;
    return `${when} · ${Number(d)}/${Number(m)}`;
  }
  const [mealType, setMealType] = useState<MealType>(() =>
    mealParam === "BREAKFAST" || mealParam === "LUNCH" || mealParam === "DINNER"
      ? mealParam
      : "LUNCH",
  );
  const [availableMeals, setAvailableMeals] = useState<
    Array<{ mealType: MealType; mealLabel: string; openDayCount: number }>
  >([]);
  /** False until /meals returns — never flash Breakfast/Dinner while loading. */
  const [mealsLoaded, setMealsLoaded] = useState(false);
  const [data, setData] = useState<WeekPayload | null>(() =>
    initialWeek && mealType === "LUNCH" ? initialWeek : null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => {
    if (!initialWeek || mealType !== "LUNCH") return null;
    return (
      initialWeek.plan.find((d) => d.itemCount > 0)?.serviceDate ??
      initialWeek.plan[0]?.serviceDate ??
      null
    );
  });
  const [cart, setCart] = useState<CartLine[]>([]);
  /** Full dock covers the day strip — stay collapsed while browsing more days. */
  const [cartExpanded, setCartExpanded] = useState(false);
  const [checkoutErr, setCheckoutErr] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reviews, setReviews] = useState<PublicReview[]>([]);
  const [payers, setPayers] = useState<string[]>([]);
  const [payerMobile, setPayerMobile] = useState<string>("");
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  /** Empty until customer picks — required each checkout for delivery. */
  const [addressId, setAddressId] = useState("");
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>("DELIVERY");
  /** Days already covered by an active order for this kitchen + meal. */
  const [orderedDates, setOrderedDates] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (mealParam === "BREAKFAST" || mealParam === "LUNCH" || mealParam === "DINNER") {
      setMealType(mealParam);
    }
  }, [mealParam]);

  useEffect(() => {
    let cancelled = false;
    setMealsLoaded(false);
    fetch(`${API_BASE}/kitchens/${slug}/meals?days=7`)
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setAvailableMeals([]);
          setMealsLoaded(true);
          return;
        }
        const meals = (json.meals as Array<{
          mealType: MealType;
          mealLabel: string;
          openDayCount: number;
        }>) ?? [];
        // Only meals the kitchen actually offers with something to order this week.
        setAvailableMeals(meals);
        setMealsLoaded(true);
        if (meals.length && !meals.some((m) => m.mealType === mealType)) {
          setMealType(meals[0].mealType);
        } else if (!meals.length) {
          setMealType("LUNCH");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailableMeals([]);
          setMealsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // Only re-probe when kitchen changes; mealType sync is intentional once.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- avoid loop when auto-selecting meal
  }, [slug]);

  useEffect(() => {
    // Already painted from SSR lunch prefetch — skip duplicate first fetch.
    if (initialWeek && mealType === "LUNCH" && data === initialWeek) {
      return;
    }
    let cancelled = false;
    setErr(null);
    setCartExpanded(false);
    fetch(`${API_BASE}/kitchens/${slug}/week?days=7&meal=${mealType}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not load menu");
        if (!cancelled) {
          setData(json as WeekPayload);
          if (!againMode) {
            const firstWithItems =
              (json as WeekPayload).plan.find((d) => d.itemCount > 0)?.serviceDate ??
              (json as WeekPayload).plan[0]?.serviceDate ??
              null;
            setSelected(firstWithItems);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional skip when SSR lunch data is already shown
  }, [slug, mealType, againMode]);

  /** From “Order another day”: land on the next free day, not the one already ordered. */
  useEffect(() => {
    if (!againMode || !data?.plan.length) return;
    const after = afterDate && /^\d{4}-\d{2}-\d{2}$/.test(afterDate) ? afterDate : "";
    const nextFree =
      data.plan.find(
        (d) =>
          d.itemCount > 0 &&
          !orderedDates.has(d.serviceDate) &&
          (!after || d.serviceDate > after),
      ) ??
      data.plan.find((d) => d.itemCount > 0 && !orderedDates.has(d.serviceDate)) ??
      data.plan.find((d) => d.itemCount > 0) ??
      data.plan[0];
    if (!nextFree) return;
    setSelected((cur) => {
      if (cur && !orderedDates.has(cur)) return cur;
      return nextFree.serviceDate;
    });
  }, [againMode, afterDate, data, orderedDates]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/kitchens/${slug}/reviews`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) return;
        if (!cancelled) setReviews((json.reviews as PublicReview[]) ?? []);
      })
      .catch(() => {
        /* public reviews optional */
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!user || user.role !== "CUSTOMER") {
      setPayers([]);
      setPayerMobile("");
      setAddresses([]);
      setAddressId("");
      setFollowing(false);
      return;
    }
    let cancelled = false;
    authFetch("/family/links")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) return;
        const active = ((json.links as Array<{ role: string; status: string; payerMobile: string }>) ?? [])
          .filter((l) => l.role === "SENIOR" && l.status === "ACTIVE")
          .map((l) => l.payerMobile);
        if (!cancelled) {
          setPayers(active);
          setPayerMobile((prev) => (prev && active.includes(prev) ? prev : ""));
        }
      })
      .catch(() => undefined);
    authFetch("/me/addresses")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || cancelled) return;
        setAddresses((json.addresses as SavedAddress[]) ?? []);
        setAddressId("");
      })
      .catch(() => undefined);
    authFetch("/me/kitchens")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || cancelled) return;
        const hit = ((json.kitchens as Array<{ slugHandle: string; followed?: boolean }>) ?? []).find(
          (k) => k.slugHandle === slug && k.followed,
        );
        setFollowing(Boolean(hit));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user, slug]);

  useEffect(() => {
    if (!user || user.role !== "CUSTOMER") {
      setOrderedDates(new Set());
      return;
    }
    let cancelled = false;
    authFetch("/me/orders")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || cancelled) return;
        const rows = (json.orders as Array<{
          cookSlug?: string | null;
          mealType?: string;
          serviceDate: string;
          status: string;
        }>) ?? [];
        const inactive = new Set(["CANCELLED", "FAILED", "REFUNDED"]);
        const dates = new Set(
          rows
            .filter(
              (o) =>
                o.cookSlug === slug &&
                o.mealType === mealType &&
                !inactive.has(o.status),
            )
            .map((o) => o.serviceDate),
        );
        setOrderedDates(dates);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user, slug, mealType]);

  async function toggleFollow() {
    if (!user || user.role !== "CUSTOMER") {
      router.push(loginPath("CUSTOMER", `/kitchen/${slug}`));
      return;
    }
    if (!following) {
      const ok = window.confirm(t("kitchen.followConsent"));
      if (!ok) return;
    }
    setFollowBusy(true);
    try {
      const path = following
        ? `/me/kitchens/${slug}/unfollow`
        : `/me/kitchens/${slug}/follow`;
      const res = await authFetch(path, {
        method: "POST",
        body: following ? "{}" : JSON.stringify({ consent: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update follow");
      setFollowing(!following);
    } catch (e) {
      setCheckoutErr(e instanceof Error ? e.message : "Follow failed");
    } finally {
      setFollowBusy(false);
    }
  }

  const day = useMemo(
    () => data?.plan.find((d) => d.serviceDate === selected) ?? data?.plan[0] ?? null,
    [data, selected],
  );

  const offers = data?.fulfillmentOffers;
  const pickupOk = Boolean(data?.pickup?.available ?? offers?.pickup);
  const effectiveFulfillment = resolveEffectiveFulfillment(
    fulfillmentMode,
    offers,
    Boolean(data?.pickup?.available),
  );
  const selectedAddress = addresses.find((a) => String(a.id) === addressId) ?? null;
  const flatDeliveryPaise = selfDeliveryFeeOn
    ? Math.round(Number(data?.cook.flatSelfDeliveryFee ?? 25) * 100)
    : 0;
  const deliveryQuote = resolveSelfDeliveryPaise({
    distanceLimitsEnabled: distanceLimitsOn,
    fulfillmentMode: effectiveFulfillment,
    flatSelfDeliveryFeePaise: flatDeliveryPaise,
    cookLat: data?.cook.lat,
    cookLng: data?.cook.lng,
    addressLat: selectedAddress?.lat,
    addressLng: selectedAddress?.lng,
    addressPinCode: selectedAddress?.pinCode,
  });
  // Until an address is chosen, show flat fee estimate; after quote resolves FREE/PAID use that.
  const deliveryPaise =
    deliveryQuote.band === "FREE"
      ? 0
      : deliveryQuote.band === "PAID" || deliveryQuote.band === "FLAT"
        ? deliveryQuote.deliveryPaise
        : deliveryQuote.band === "ZERO_FULFILLMENT"
          ? 0
          : flatDeliveryPaise;
  const deliveryBlocked =
    effectiveFulfillment === "DELIVERY" &&
    distanceLimitsOn &&
    (deliveryQuote.band === "TOO_FAR" ||
      (Boolean(addressId) && deliveryQuote.band === "MISSING_COORDS"));
  const needsAddress = needsCheckoutAddress(effectiveFulfillment);

  const weekRule = data?.weekDiscount;
  const cartDayCount = useMemo(
    () => new Set(cart.map((c) => c.serviceDate)).size,
    [cart],
  );
  const weekDiscountOn = Boolean(
    weekRule && weekRule.percent > 0 && cartDayCount >= (weekRule.minDays ?? 3),
  );

  const cartTotalPaise = useMemo(() => {
    const pct = weekDiscountOn ? (weekRule?.percent ?? 0) : 0;
    const linesPaise = cart.reduce((s, line) => {
      const food = line.pricePaise * line.qty;
      const discount = pct > 0 ? Math.floor((food * pct) / 100) : 0;
      return s + food - discount + deliveryPaise;
    }, 0);
    // ₹7 once per week checkout (matches API createOrderBatch)
    const fee = cart.length > 0 ? platformFeePaise() : 0;
    return linesPaise + fee;
  }, [cart, deliveryPaise, weekDiscountOn, weekRule?.percent, fulfillmentMode]);

  const cartDiscountPaise = useMemo(() => {
    if (!weekDiscountOn || !weekRule) return 0;
    return cart.reduce((s, line) => {
      const food = line.pricePaise * line.qty;
      return s + Math.floor((food * weekRule.percent) / 100);
    }, 0);
  }, [cart, weekDiscountOn, weekRule]);

  const cartFoodPaise = useMemo(
    () => cart.reduce((s, line) => s + line.pricePaise * line.qty, 0),
    [cart],
  );
  const cartDeliveryPaise = deliveryPaise * cart.length;
  const cartPlatformPaise = cart.length > 0 ? platformFeePaise() : 0;

  function confirmAnotherOrderIfNeeded(serviceDate: string): boolean {
    if (!orderedDates.has(serviceDate)) return true;
    return window.confirm(t("kitchen.confirmAnotherOrder"));
  }

  function addToCart(line: CartAddPayload) {
    if (!confirmAnotherOrderIfNeeded(line.serviceDate)) return;
    setCheckoutErr(null);
    setCart((prev) => {
      // One plate per meal per day — breakfast + lunch + dinner same date is OK.
      const withoutSlot = prev.filter(
        (p) => !(p.serviceDate === line.serviceDate && p.mealType === mealType),
      );
      const mealRank: Record<MealType, number> = { BREAKFAST: 0, LUNCH: 1, DINNER: 2 };
      return [
        ...withoutSlot,
        {
          ...line,
          mealType,
          mealLabel: MEALS.find((m) => m.id === mealType)?.label ?? t("meal.lunch"),
        },
      ].sort((a, b) => {
        const byDate = a.serviceDate.localeCompare(b.serviceDate);
        if (byDate !== 0) return byDate;
        return mealRank[a.mealType] - mealRank[b.mealType];
      });
    });
    // Keep dock collapsed so the day strip stays tappable for more days.
    setCartExpanded(false);
  }

  function removeFromCart(serviceDate: string, lineMeal: MealType = mealType) {
    setCart((prev) =>
      prev.filter((p) => !(p.serviceDate === serviceDate && p.mealType === lineMeal)),
    );
  }

  function selectServiceDay(serviceDate: string) {
    setSelected(serviceDate);
    // Switching days is for adding plates — collapse checkout sheet if open.
    setCartExpanded(false);
  }

  // Empty cart → collapse; checkout errors only make sense in the expanded sheet.
  useEffect(() => {
    if (cart.length === 0) setCartExpanded(false);
  }, [cart.length]);

  useEffect(() => {
    if (checkoutErr) setCartExpanded(true);
  }, [checkoutErr]);

  useEffect(() => {
    if (addressId || !needsAddress) setCheckoutErr(null);
  }, [addressId, effectiveFulfillment]);

  async function checkout() {
    if (!user || user.role !== "CUSTOMER") {
      router.push(loginPath("CUSTOMER", `/kitchen/${slug}`));
      return;
    }
    if (!cart.length) return;
    if (needsAddress && !addressId) {
      setCheckoutErr(t("address.chooseFirst"));
      return;
    }
    if (deliveryBlocked) {
      setCheckoutErr(
        deliveryQuote.band === "TOO_FAR"
          ? t("cart.deliveryTooFar")
          : t("cart.deliveryDistanceUnavailable"),
      );
      return;
    }
    const overlaps = cart.some((c) => orderedDates.has(c.serviceDate));
    if (overlaps && !window.confirm(t("kitchen.confirmAnotherOrder"))) return;
    // Confirm-before-pay: breakdown, credit, payment method, cut-off note.
    setConfirmOpen(true);
  }

  async function placeCheckout(choice: ConfirmPayChoice) {
    if (!user) return;
    setCheckingOut(true);
    setCheckoutErr(null);
    try {
      const res = await authFetch("/orders/batch", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          customerMobile: user.mobile,
          cookSlug: slug,
          payerMobile: payerMobile || null,
          fulfillmentMode: effectiveFulfillment,
          addressId: needsAddress ? Number(addressId) : null,
          useCredit: choice.useCredit,
          paymentMethod: choice.paymentMethod,
          lines: cart.map((c) => ({
            menuItemId: c.menuItemId,
            serviceDate: c.serviceDate,
            qty: c.qty,
            spice: c.spice,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Checkout failed");
      setConfirmOpen(false);
      setCart([]);
      setAddressId("");
      // Fully paid by LocalMeals credit — nothing to pay.
      if (json.status === "PAID") {
        router.push(`/order/confirmed/${json.checkoutId}`);
        return;
      }
      // Child Pays: senior waits — payer gets the pay link / WA
      if (payerMobile) {
        router.push(`/order/confirmed/${json.checkoutId}`);
        return;
      }
      if (isExternalPaymentUrl(json.paymentUrl)) {
        window.location.href = json.paymentUrl as string;
        return;
      }
      router.push(payPageHref(json.checkoutId, json.gatewayTxnId));
    } catch (e) {
      setConfirmOpen(false);
      setCheckoutErr(e instanceof Error ? e.message : "Checkout failed");
    } finally {
      setCheckingOut(false);
    }
  }

  const confirmSummary: ConfirmPaySummary = useMemo(() => {
    const pct = weekDiscountOn ? (weekRule?.percent ?? 0) : 0;
    const platform = cart.length > 0 ? platformFeePaise() : 0;
    const sorted = [...cart].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));
    return {
      rows: sorted.map((c, i) => ({
        key: `${c.serviceDate}-${c.menuItemId}-${i}`,
        label: `${c.serviceDate} · ${c.qty}× ${c.itemName}`,
        amountPaise: c.pricePaise * c.qty,
      })),
      lineBasesPaise: sorted.map((c, i) => {
        const food = c.pricePaise * c.qty;
        const discount = pct > 0 ? Math.floor((food * pct) / 100) : 0;
        return food - discount + deliveryPaise + (i === 0 ? platform : 0);
      }),
      foodPaise: cartFoodPaise,
      discountPaise: cartDiscountPaise,
      deliveryPaise: cartDeliveryPaise,
      platformPaise: platform,
      fulfillmentMode: effectiveFulfillment,
      cutoff: data?.cutoff ?? data?.lunchCutoff ?? null,
      childPays: Boolean(payerMobile),
    };
  }, [cart, weekDiscountOn, weekRule?.percent, deliveryPaise, cartFoodPaise, cartDiscountPaise, cartDeliveryPaise, effectiveFulfillment, data?.cutoff, data?.lunchCutoff, payerMobile]);

  if (err) return <p className="err">{err}</p>;
  if (!data || !day) return <p className="muted">Loading week’s menu…</p>;

  const cutoff = data.cutoff ?? data.lunchCutoff ?? "08:00";
  const mealName =
    MEALS.find((m) => m.id === mealType)?.label ?? data.mealLabel ?? t("meal.lunch");
  const inCartForDay = cart.find(
    (c) => c.serviceDate === day.serviceDate && c.mealType === mealType,
  );

  const statusText =
    data.openStatusLabel ??
    (data.orderingOpen
      ? t("kitchen.openStatus", { cutoff })
      : data.nextServiceDate
        ? t("kitchen.closedNext", { date: data.nextServiceDate })
        : t("kitchen.closed"));

  return (
    <main
      className={`kitchen-page${cart.length ? " has-cart" : ""}${
        cart.length && cartExpanded ? " has-cart-expanded" : ""
      }`}
    >
      {confirmOpen ? (
        <ConfirmPayDialog
          summary={confirmSummary}
          busy={checkingOut}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(choice) => void placeCheckout(choice)}
        />
      ) : null}
      <header className="kitchen-hero">
        <div className="kitchen-hero-top">
          <div className="kitchen-hero-titles">
            <p className="kitchen-kicker">{t("kitchen.kicker")}</p>
            <h1>{data.cook.kitchenName}</h1>
          </div>
          {followOn ? (
            <button
              type="button"
              className={`btn sm kitchen-follow${following ? " on" : ""}`}
              disabled={followBusy}
              onClick={() => void toggleFollow()}
            >
              {followBusy ? "…" : following ? t("common.following") : t("common.follow")}
            </button>
          ) : null}
        </div>

        <div className="kitchen-status-row">
          <span className={`chip kitchen-status-chip${data.orderingOpen ? " tone-go" : " tone-warn"}`}>
            {statusText}
          </span>
          {reviewsOn && data.reviews?.public && data.reviews.average != null ? (
            <span className="kitchen-rating">
              ★ {data.reviews.average.toFixed(1)} · {data.reviews.count}
            </span>
          ) : (
            <span className="kitchen-rating muted">{t("common.newKitchen")}</span>
          )}
        </div>

        <ul className="kitchen-facts meta-list" aria-label="Kitchen details">
          <li>
            <span className="kitchen-fact-inline-label">FSSAI</span>{" "}
            {data.cook.fssaiNumber ?? "—"}
          </li>
          <li>
            <span className="kitchen-fact-inline-label">{t("kitchen.window")}</span>{" "}
            {data.deliveryWindow ?? "12:00–13:00"}
          </li>
          {data.cook.deliveryType === "PARTNER" ? (
            <li>
              <span className="kitchen-fact-inline-label">{t("confirmed.partnerLogistics")}</span>{" "}
              {t("confirmed.deliveredByPartner")}
            </li>
          ) : null}
        </ul>

        {data.cook.deliveryType === "PARTNER" ? (
          <p className="muted kitchen-partner-note" style={{ margin: "0.35rem 0 0" }}>
            {t("kitchen.partnerDeliveryNote")}
          </p>
        ) : null}

        {data.weekDiscount?.label ? (
          <p className="ok kitchen-discount">{data.weekDiscount.label}</p>
        ) : null}

        {user?.role === "CUSTOMER" ? (
          <div className="kitchen-order-bar">
            {data?.intakePaused ? (
              <p className="err">{t("cart.kitchenPaused")}</p>
            ) : null}
            <FulfillmentChooser
              value={effectiveFulfillment}
              onChange={setFulfillmentMode}
              offers={offers}
              pickupAvailable={Boolean(data?.pickup?.available)}
            />
            {effectiveFulfillment === "PICKUP" && data?.pickup?.hint ? (
              <p className="muted kitchen-pickup-hint">{data.pickup.hint}</p>
            ) : null}
            {needsAddress ? (
              <CheckoutAddressPicker
                addresses={addresses}
                addressId={addressId}
                onChange={setAddressId}
                onCreated={(a) => setAddresses((prev) => [...prev, a])}
                required
                compact
              />
            ) : null}
            {childPaysOn && payers.length > 0 ? (
              <label className="kitchen-payer muted">
                {t("cart.whoPays")}
                <select
                  value={payerMobile}
                  onChange={(e) => setPayerMobile(e.target.value)}
                >
                  <option value="">{t("common.me")}</option>
                  {payers.map((p) => (
                    <option key={p} value={p}>
                      {t("cart.family", { mobile: p })}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="kitchen-sticky-tools">
        {(() => {
          // Never fall back to Breakfast/Lunch/Dinner — that showed empty tabs for lunch-only kitchens.
          const tabs = mealsLoaded
            ? availableMeals.length
              ? availableMeals.map((m) => ({
                  id: m.mealType,
                  label:
                    availableMeals.length > 1 && m.openDayCount
                      ? `${m.mealLabel} · ${m.openDayCount}d`
                      : m.mealLabel,
                }))
              : [{ id: "LUNCH" as MealType, label: t("meal.lunch") }]
            : [{ id: "LUNCH" as MealType, label: t("meal.lunch") }];
          // One meal only → no tab strip (lunch-only kitchens shouldn't look like a 3-slot product).
          if (tabs.length <= 1) return null;
          return (
            <div className="seg meal-seg" role="tablist" aria-label={t("kitchen.mealTabs")}>
              {tabs.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={mealType === m.id}
                  className={mealType === m.id ? "on" : ""}
                  onClick={() => setMealType(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          );
        })()}
        {againMode ? (
          <p className="muted kitchen-reorder-hint" style={{ margin: "0.35rem 0 0.5rem" }}>
            {t("kitchen.reorderHint")}
          </p>
        ) : null}

        {data.mealEnabled !== false ? (
          <div className="day-strip" role="tablist" aria-label="Service days">
            {data.plan.map((d) => {
              const carted = cart.some(
                (c) => c.serviceDate === d.serviceDate && c.mealType === mealType,
              );
              const alreadyOrdered = orderedDates.has(d.serviceDate);
              return (
                <button
                  key={d.serviceDate}
                  type="button"
                  role="tab"
                  aria-selected={d.serviceDate === day.serviceDate}
                  className={[
                    "day-chip",
                    d.serviceDate === day.serviceDate ? "on" : "",
                    d.itemCount === 0 ? "empty" : "",
                    carted ? "carted" : "",
                    alreadyOrdered ? "ordered" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => selectServiceDay(d.serviceDate)}
                >
                  <span className="day-chip-label">{d.isToday ? t("common.today") : d.dayLabel}</span>
                  <span className="day-chip-date">{d.serviceDate.slice(8)}</span>
                  <span className="day-chip-count">
                    {alreadyOrdered
                      ? t("kitchen.ordered")
                      : carted
                        ? t("kitchen.inCart")
                        : d.itemCount > 0
                          ? d.itemCount === 1
                            ? t("kitchen.plates", { n: d.itemCount })
                            : t("kitchen.plates_plural", { n: d.itemCount })
                          : "—"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {data.mealEnabled === false ? (
        <div className="kitchen-empty">
          <strong>{t("kitchen.mealOffTitle", { meal: mealName })}</strong>
          <p className="muted">{t("kitchen.mealOffBody", { meal: mealName })}</p>
          <button className="btn" type="button" onClick={() => setMealType("LUNCH")}>
            {t("kitchen.showLunch")}
          </button>
        </div>
      ) : (
        <>
          <section className="day-panel">
            <div className="day-head">
              <h2>
                {mealName} · {formatDayTitle(day)}
              </h2>
              <span className={`chip${day.orderingOpen ? " tone-go" : " tone-warn"}`}>
                {day.orderingOpen
                  ? t("kitchen.orderingOpen")
                  : day.lateOrderingOpen && data.lateOrdersEnabled !== false
                    ? t("kitchen.pastCutoff")
                    : t("kitchen.orderingClosed")}
              </span>
            </div>

            {orderedDates.has(day.serviceDate) ? (
              <div className="cart-day-banner tone-warn">
                <span>{t("kitchen.alreadyOrderedDay")}</span>
                <Link className="btn sm secondary" href="/orders">
                  {t("orders.title")}
                </Link>
              </div>
            ) : null}
            {inCartForDay ? (
              <div className="ok cart-day-banner">
                <span>
                  {t("kitchen.inWeekCart", {
                    qty: inCartForDay.qty,
                    item: localizedDishName(locale, inCartForDay),
                  })}
                </span>
                <button
                  type="button"
                  className="btn sm secondary"
                  onClick={() => removeFromCart(day.serviceDate, mealType)}
                >
                  {t("common.remove")}
                </button>
              </div>
            ) : null}

            {day.menus.length === 0 ? (
              <div className="kitchen-empty compact">
                <strong>{t("kitchen.noMealDay", { meal: mealName })}</strong>
                <p className="muted">{t("kitchen.noMealDayHint")}</p>
              </div>
            ) : (
              day.menus.map((m) => {
                const src = imgSrc(m.imageUrl);
                const dish = localizedDishName(locale, m);
                const source =
                  m.serviceDate == null
                    ? t("common.weekly")
                    : m.serviceDate === day.serviceDate
                      ? t("common.thisDate")
                      : null;
                return (
                  <article
                    key={`${day.serviceDate}-${m.id}`}
                    className="plate-card"
                    style={{ animationDelay: `${Math.min(day.menus.indexOf(m), 4) * 60}ms` }}
                  >
                    {src ? (
                      <div className="plate-media">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="plate-photo" src={src} alt={dish} />
                      </div>
                    ) : (
                      <div className="plate-fallback" aria-hidden>
                        <span className="plate-fallback-mark">{t("common.plate")}</span>
                        <span className="plate-fallback-name">{dish}</span>
                      </div>
                    )}
                    <div className="plate-body">
                      <div className="plate-meta">
                        <div>
                          <strong className="plate-name">{dish}</strong>
                          <p className="muted plate-sub">
                            {m.isVeg ? t("common.veg") : t("common.nonVeg")}
                            {source ? ` · ${source}` : ""}
                            {m.allergens?.length
                              ? ` · ${t("kitchen.allergens")}: ${m.allergens.join(", ")}`
                              : ""}
                          </p>
                          {m.portionNote ? (
                            <p className="plate-portion">{m.portionNote}</p>
                          ) : null}
                        </div>
                        <strong className="plate-price">₹{(m.pricePaise / 100).toFixed(0)}</strong>
                      </div>
                      <OrderForm
                        cookSlug={slug}
                        menuItemId={m.id}
                        itemName={m.itemName}
                        itemNameTa={m.itemNameTa}
                        serviceDate={day.serviceDate}
                        pricePaise={m.pricePaise}
                        orderingOpen={day.orderingOpen}
                        lateOrdersEnabled={
                          data.lateOrdersEnabled !== false && Boolean(day.lateOrderingOpen)
                        }
                        onAddToCart={day.orderingOpen ? addToCart : undefined}
                        confirmBeforeOrder={
                          orderedDates.has(day.serviceDate)
                            ? () => window.confirm(t("kitchen.confirmAnotherOrder"))
                            : undefined
                        }
                        addressId={addressId}
                        needsAddress={needsAddress}
                        fulfillmentMode={effectiveFulfillment}
                        payerMobile={payerMobile || null}
                      />
                    </div>
                  </article>
                );
              })
            )}
          </section>
        </>
      )}

      {reviewsOn && data.reviews?.public && reviews.length > 0 ? (
        <section className="kitchen-reviews" aria-label={t("kitchen.reviews")}>
          <h2>{t("kitchen.reviews")}</h2>
          <p className="muted">
            {t("kitchen.reviewsAvg", {
              avg: data.reviews.average?.toFixed(1) ?? "—",
              count: data.reviews.count,
            })}
          </p>
          <ul className="review-list">
            {reviews.map((r) => (
              <li key={r.id} className="review-item">
                <div className="review-item-head">
                  <span className="review-stars" aria-label={`${r.rating} stars`}>
                    {"★".repeat(r.rating)}
                    {"☆".repeat(5 - r.rating)}
                  </span>
                  <span className="muted">{r.customerLabel}</span>
                </div>
                {r.comment ? <p className="review-comment">{r.comment}</p> : null}
                {r.cookReply ? (
                  <p className="review-cook-reply">
                    <strong>{t("kitchen.cookReply")}</strong> {r.cookReply}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {cart.length > 0 ? (
        <div
          className={`cart-dock${cartExpanded ? " is-expanded" : " is-collapsed"}`}
          role="dialog"
          aria-label={
            cartDayCount === 1
              ? t("cart.title", { n: cartDayCount })
              : t("cart.title_plural", { n: cartDayCount })
          }
          aria-expanded={cartExpanded}
        >
          {!cartExpanded ? (
            <div className="cart-dock-compact">
              <button
                type="button"
                className="cart-dock-compact-main"
                onClick={() => setCartExpanded(true)}
              >
                <span className="cart-dock-compact-copy">
                  <strong className="cart-dock-title">
                    {cartDayCount === 1
                      ? t("cart.title", { n: cartDayCount })
                      : t("cart.title_plural", { n: cartDayCount })}
                  </strong>
                  <span className="muted cart-dock-compact-hint">{t("cart.addMoreDays")}</span>
                </span>
                <strong className="cart-dock-total">₹{(cartTotalPaise / 100).toFixed(0)}</strong>
              </button>
              <div className="cart-dock-compact-actions">
                <button
                  type="button"
                  className="btn sm secondary"
                  onClick={() => setCartExpanded(true)}
                >
                  {t("cart.reviewPay")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="cart-dock-sum">
                <div>
                  <strong className="cart-dock-title">
                    {cartDayCount === 1
                      ? t("cart.title", { n: cartDayCount })
                      : t("cart.title_plural", { n: cartDayCount })}
                  </strong>
                  <button
                    type="button"
                    className="cart-dock-collapse"
                    onClick={() => setCartExpanded(false)}
                  >
                    {t("cart.keepBrowsing")}
                  </button>
                </div>
                <div style={{ textAlign: "right" }}>
                  <strong className="cart-dock-total">₹{(cartTotalPaise / 100).toFixed(0)}</strong>
                  {cartDiscountPaise > 0 ? (
                    <p className="ok" style={{ margin: "0.15rem 0 0", fontSize: "0.82rem" }}>
                      {t("cart.weekOff", { amount: (cartDiscountPaise / 100).toFixed(0) })}
                    </p>
                  ) : weekRule?.percent &&
                    cartDayCount > 0 &&
                    cartDayCount < weekRule.minDays ? (
                    <p className="muted" style={{ margin: "0.15rem 0 0", fontSize: "0.78rem" }}>
                      {weekRule.minDays - cartDayCount === 1
                        ? t("cart.addMore", {
                            n: weekRule.minDays - cartDayCount,
                            pct: weekRule.percent,
                          })
                        : t("cart.addMore_plural", {
                            n: weekRule.minDays - cartDayCount,
                            pct: weekRule.percent,
                          })}
                    </p>
                  ) : null}
                </div>
              </div>
              <ul className="cart-dock-lines" aria-label={t("cart.orderDetails")}>
                {[...cart].map((line) => {
                    const dayMeta = data.plan.find((d) => d.serviceDate === line.serviceDate);
                    const dayTitle = dayMeta
                      ? formatDayTitle(dayMeta)
                      : line.serviceDate.slice(5);
                    const lineFood = line.pricePaise * line.qty;
                    return (
                      <li
                        key={`${line.serviceDate}-${line.mealType}-${line.menuItemId}`}
                        className="cart-dock-line"
                      >
                        <div className="cart-dock-line-main">
                          <strong className="cart-dock-line-item">
                            {localizedDishName(locale, line)}
                          </strong>
                          <span className="muted cart-dock-line-meta">
                            {dayTitle} · {line.mealLabel}
                            {line.qty > 1 ? ` · ×${line.qty}` : ""}
                            {line.spice === "LESS" ? ` · ${t("cart.lessSpice")}` : ""}
                          </span>
                        </div>
                        <div className="cart-dock-line-side">
                          <span className="cart-dock-line-price">₹{(lineFood / 100).toFixed(0)}</span>
                          <button
                            type="button"
                            className="cart-dock-line-remove"
                            aria-label={`${t("cart.removeLine")} ${localizedDishName(locale, line)}`}
                            onClick={() => removeFromCart(line.serviceDate, line.mealType)}
                          >
                            {t("cart.removeLine")}
                          </button>
                        </div>
                      </li>
                    );
                  })}
              </ul>
              <FulfillmentChooser
                value={effectiveFulfillment}
                onChange={setFulfillmentMode}
                offers={offers}
                pickupAvailable={Boolean(data?.pickup?.available)}
                className="seg"
                style={{ marginTop: "0.55rem" }}
              />
              {effectiveFulfillment === "PICKUP" && data?.pickup?.hint ? (
                <p className="muted" style={{ margin: "0.4rem 0 0", fontSize: "0.82rem" }}>
                  {data.pickup.hint}
                </p>
              ) : null}
              {needsAddress ? (
                <div
                  className={`cart-dock-address${
                    checkoutErr && !addressId ? " needs-address" : ""
                  }`}
                >
                  <CheckoutAddressPicker
                    addresses={addresses}
                    addressId={addressId}
                    onChange={setAddressId}
                    onCreated={(a) => setAddresses((prev) => [...prev, a])}
                    required
                  />
                </div>
              ) : null}
              <ul className="meta-list cart-fee-break" style={{ margin: "0.45rem 0 0.15rem" }}>
                <li>
                  {cartDiscountPaise > 0
                    ? t("cart.foodOff", {
                        amount: (cartFoodPaise / 100).toFixed(0),
                        off: (cartDiscountPaise / 100).toFixed(0),
                      })
                    : t("cart.food", { amount: (cartFoodPaise / 100).toFixed(0) })}
                </li>
                <li>
                  {effectiveFulfillment === "PICKUP"
                    ? t("cart.pickupFee")
                    : effectiveFulfillment === "CUSTOMER_ARRANGE"
                      ? t("cart.customerArrangeFee")
                      : deliveryQuote.band === "FREE"
                        ? t("cart.deliveryFree")
                        : t("cart.deliveryFee", {
                            amount: (cartDeliveryPaise / 100).toFixed(0),
                          })}
                </li>
                {distanceLimitsOn && effectiveFulfillment === "DELIVERY" ? (
                  <li className="muted">{t("cart.deliveryDistanceHint")}</li>
                ) : null}
                {deliveryBlocked ? (
                  <li className="tone-warn">
                    {deliveryQuote.band === "TOO_FAR"
                      ? t("cart.deliveryTooFar")
                      : t("cart.deliveryDistanceUnavailable")}
                  </li>
                ) : null}
                {!isSoloKitchenMode() ? (
                  <li>
                    {t("cart.platform", { amount: (cartPlatformPaise / 100).toFixed(0) })}
                  </li>
                ) : null}
              </ul>
              {childPaysOn && payers.length > 0 ? (
                <label className="cart-dock-payer muted">
                  {t("cart.whoPays")}
                  <select
                    value={payerMobile}
                    onChange={(e) => setPayerMobile(e.target.value)}
                    style={{ marginLeft: "0.35rem" }}
                  >
                    <option value="">{t("common.me")}</option>
                    {payers.map((p) => (
                      <option key={p} value={p}>
                        {t("cart.family", { mobile: p })}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {checkoutErr ? <p className="err">{checkoutErr}</p> : null}
              <div className="cart-dock-actions">
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => {
                    setCart([]);
                    setCartExpanded(false);
                  }}
                >
                  {t("common.clear")}
                </button>
                <button
                  className="btn mustard"
                  type="button"
                  disabled={checkingOut || deliveryBlocked}
                  onClick={() => void checkout()}
                >
                  {checkingOut
                    ? t("cart.checkingOut")
                    : payerMobile
                      ? t("cart.askFamily")
                      : t("cart.payWeek")}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </main>
  );
}
