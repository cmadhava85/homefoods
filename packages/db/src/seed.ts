import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import {
  addresses,
  cookMealSettings,
  cookProfiles,
  dailyMenus,
  familyLinks,
  orders,
  payments,
  subscriptions,
  supportTickets,
  users,
} from "./schema.js";
import { defaultMealSchedule, MEAL_PERIODS, serviceDateISO } from "@localmeals/domain";

async function main() {
  const db = createDb();
  const today = serviceDateISO();
  const demoHour = Number(process.env.LUNCH_CUTOFF_HOUR ?? 8);
  const demoMinute = Number(process.env.LUNCH_CUTOFF_MINUTE ?? 0);

  await db
    .insert(users)
    .values([
      {
        mobileNumber: "+919840111111",
        fullName: "Rahul",
        preferredLanguage: "en",
        segment: "BACHELOR",
        primaryAddress: "Tower 3, Flat 1204, OMR Sholinganallur",
        pinCode: "600119",
      },
      {
        mobileNumber: "+919840222222",
        fullName: "Ramesh",
        preferredLanguage: "en",
        segment: "BACHELOR",
        primaryAddress: "Block B, Flat 501, Green Fields",
        pinCode: "600119",
      },
      {
        mobileNumber: "+919840333333",
        fullName: "Priya (Child payer)",
        preferredLanguage: "en",
        segment: "CHILD_PAYER",
        primaryAddress: "Remote",
        pinCode: "600001",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(addresses)
    .values([
      {
        userMobile: "+919840111111",
        label: "HOME",
        line1: "Tower 3, Flat 1204, OMR Sholinganallur",
        pinCode: "600119",
        lat: "12.9015000",
        lng: "80.2275000",
        isDefault: true,
      },
      {
        userMobile: "+919840222222",
        label: "HOME",
        line1: "Block B, Flat 501, Green Fields",
        pinCode: "600119",
        isDefault: true,
      },
      {
        userMobile: "+919840333333",
        label: "HOME",
        line1: "Remote",
        pinCode: "600001",
        isDefault: true,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(familyLinks)
    .values({
      seniorMobile: "+919840111111",
      payerMobile: "+919840333333",
      status: "ACTIVE",
      activatedAt: new Date(),
    })
    .onConflictDoNothing();

  // Migrate older local seed slug → launch kitchen.
  await db
    .update(cookProfiles)
    .set({
      kitchenName: "CSK Homemade Delights",
      slugHandle: "csk-homemade-delights",
      payoutBeneficiaryRef: "rzp_acc_csk_homemade_demo",
      payoutUpiId: "cskhomemade@upi",
      deliveryType: "SELF",
      flatSelfDeliveryFee: "25.00",
      maxSelfDistanceKm: "3.0",
      offerCustomerArrange: false,
    })
    .where(eq(cookProfiles.slugHandle, "sri-sai"));

  const cookSeeds = [
    {
      mobileNumber: "+919876543210",
      kitchenName: "CSK Homemade Delights",
      slugHandle: "csk-homemade-delights",
      lat: "12.9010000",
      lng: "80.2270000",
      pinCode: "600119",
      onboardingStatus: "LIVE" as const,
      fssaiNumber: "10012345678901",
      fssaiVerifiedAt: new Date(),
      isActive: true,
      maxDailyCapacity: 40,
      lunchCutoffHour: demoHour,
      lunchCutoffMinute: demoMinute,
      payoutBeneficiaryRef: "rzp_acc_csk_homemade_demo",
      payoutUpiId: "cskhomemade@upi",
      weekDiscountPercent: 10,
      weekDiscountMinDays: 3,
      // Solo launch: SELF delivery, ₹25 delivery fee, no customer-arrange; platform fee ₹0 via solo env.
      deliveryType: "SELF" as const,
      flatSelfDeliveryFee: "25.00",
      maxSelfDistanceKm: "3.0",
      offerCookDelivery: true,
      pickupEnabled: false,
      offerCustomerArrange: false,
    },
    {
      mobileNumber: "+919876543211",
      kitchenName: "Amma Priya’s",
      slugHandle: "amma-priya",
      lat: "12.9050000",
      lng: "80.2300000",
      pinCode: "600119",
      onboardingStatus: "LIVE" as const,
      fssaiNumber: "10012345678902",
      fssaiVerifiedAt: new Date(),
      isActive: true,
      lunchCutoffHour: demoHour >= 12 ? demoHour : 9,
      lunchCutoffMinute: demoHour >= 12 ? demoMinute : 30,
      payoutBeneficiaryRef: "rzp_acc_amma_demo",
      payoutUpiId: "ammapriya@upi",
    },
    {
      mobileNumber: "+919876543212",
      kitchenName: "OMR Millet Box",
      slugHandle: "millet-box",
      lat: "12.8980000",
      lng: "80.2200000",
      pinCode: "600119",
      onboardingStatus: "DOCS_SUBMITTED" as const,
      fssaiNumber: null,
      isActive: true,
      lunchCutoffHour: demoHour,
      lunchCutoffMinute: demoMinute,
      payoutBeneficiaryRef: null,
    },
  ];
  for (const cook of cookSeeds) {
    await db.insert(cookProfiles).values(cook).onConflictDoNothing();
    await db
      .update(cookProfiles)
      .set({
        kitchenName: cook.kitchenName,
        lunchCutoffHour: cook.lunchCutoffHour,
        lunchCutoffMinute: cook.lunchCutoffMinute,
        payoutBeneficiaryRef: cook.payoutBeneficiaryRef,
        payoutUpiId: "payoutUpiId" in cook ? ((cook as { payoutUpiId?: string }).payoutUpiId ?? null) : null,
        isActive: cook.isActive,
        weekDiscountPercent:
          "weekDiscountPercent" in cook ? (cook.weekDiscountPercent as number) : 0,
        weekDiscountMinDays:
          "weekDiscountMinDays" in cook ? (cook.weekDiscountMinDays as number) : 3,
        ...("offerCookDelivery" in cook
          ? { offerCookDelivery: (cook as { offerCookDelivery: boolean }).offerCookDelivery }
          : {}),
        ...("pickupEnabled" in cook
          ? { pickupEnabled: (cook as { pickupEnabled: boolean }).pickupEnabled }
          : {}),
        ...("offerCustomerArrange" in cook
          ? {
              offerCustomerArrange: (cook as { offerCustomerArrange: boolean })
                .offerCustomerArrange,
            }
          : {}),
        ...("deliveryType" in cook
          ? { deliveryType: (cook as { deliveryType: "SELF" | "PARTNER" }).deliveryType }
          : {}),
        ...("flatSelfDeliveryFee" in cook
          ? {
              flatSelfDeliveryFee: (cook as { flatSelfDeliveryFee: string })
                .flatSelfDeliveryFee,
            }
          : {}),
        ...("maxSelfDistanceKm" in cook
          ? {
              maxSelfDistanceKm: (cook as { maxSelfDistanceKm: string }).maxSelfDistanceKm,
            }
          : {}),
      })
      .where(eq(cookProfiles.slugHandle, cook.slugHandle));
  }

  const csk = await db.query.cookProfiles.findFirst({
    where: eq(cookProfiles.slugHandle, "csk-homemade-delights"),
  });
  const amma = await db.query.cookProfiles.findFirst({
    where: eq(cookProfiles.slugHandle, "amma-priya"),
  });

  const allCooks = await db.query.cookProfiles.findMany();
  for (const cook of allCooks) {
    for (const meal of MEAL_PERIODS) {
      const def = defaultMealSchedule(meal);
      const cutoffHour =
        meal === "LUNCH" ? (cook.lunchCutoffHour ?? def.cutoff.hour) : def.cutoff.hour;
      const cutoffMinute =
        meal === "LUNCH" ? (cook.lunchCutoffMinute ?? def.cutoff.minute) : def.cutoff.minute;
      const deliveryStartHour =
        meal === "LUNCH"
          ? (cook.deliveryWindowStartHour ?? def.deliveryWindow.startHour)
          : def.deliveryWindow.startHour;
      const deliveryStartMinute =
        meal === "LUNCH"
          ? (cook.deliveryWindowStartMinute ?? def.deliveryWindow.startMinute)
          : def.deliveryWindow.startMinute;
      const deliveryEndHour =
        meal === "LUNCH"
          ? (cook.deliveryWindowEndHour ?? def.deliveryWindow.endHour)
          : def.deliveryWindow.endHour;
      const deliveryEndMinute =
        meal === "LUNCH"
          ? (cook.deliveryWindowEndMinute ?? def.deliveryWindow.endMinute)
          : def.deliveryWindow.endMinute;
      await db
        .insert(cookMealSettings)
        .values({
          cookId: cook.id,
          mealType: meal,
          enabled: def.enabled,
          cutoffHour,
          cutoffMinute,
          deliveryStartHour,
          deliveryStartMinute,
          deliveryEndHour,
          deliveryEndMinute,
        })
        .onConflictDoNothing();
    }
  }

  if (csk) {
    await db
      .insert(subscriptions)
      .values({
        userMobile: "+919840111111",
        cookId: csk.id,
        mealType: "LUNCH",
        isActive: true,
      })
      .onConflictDoNothing();
  }

  if (csk) {
    const todayMenu = await db.query.dailyMenus.findFirst({
      where: (t, { eq: e, and: a }) =>
        a(e(t.cookId, csk.id), e(t.serviceDate, today)),
    });
    if (!todayMenu) {
      await db.insert(dailyMenus).values([
        {
          cookId: csk.id,
          itemName: "Sambar Rice + Poriyal",
          itemNameTa: "சாம்பார் சாதம் + பொரியல்",
          pricePaise: 8000,
          serviceDate: today,
          mealType: "LUNCH",
          isVeg: true,
          allergens: ["dairy"],
        },
        {
          cookId: csk.id,
          itemName: "Chapathi (3) + Dal",
          itemNameTa: "சப்பாத்தி (3) + பருப்பு",
          pricePaise: 9000,
          serviceDate: today,
          mealType: "LUNCH",
          isVeg: true,
          allergens: [],
        },
      ]);
    }
  }

  if (amma) {
    const todayMenu = await db.query.dailyMenus.findFirst({
      where: (t, { eq: e, and: a }) =>
        a(e(t.cookId, amma.id), e(t.serviceDate, today)),
    });
    if (!todayMenu) {
      await db.insert(dailyMenus).values([
        {
          cookId: amma.id,
          itemName: "Curd Rice + Pickle",
          itemNameTa: "தயிர் சாதம் + ஊறுகாய்",
          pricePaise: 7000,
          serviceDate: today,
          mealType: "LUNCH",
          isVeg: true,
          allergens: ["dairy"],
        },
      ]);
    }
  }

  if (csk) {
    const existing = await db.query.orders.findFirst({
      where: eq(orders.publicId, "LM-SEED01"),
    });
    if (!existing) {
      const menu = await db.query.dailyMenus.findFirst({
        where: (t, { eq: e, and: a }) =>
          a(e(t.cookId, csk.id), e(t.serviceDate, today), e(t.itemName, "Sambar Rice + Poriyal")),
      });
      const home = await db.query.addresses.findFirst({
        where: (t, { eq: e, and: a }) =>
          a(e(t.userMobile, "+919840111111"), e(t.label, "HOME")),
      });
      const [order] = await db
        .insert(orders)
        .values({
          publicId: "LM-SEED01",
          traceId: "trc_seed_lmseed01",
          customerMobile: "+919840111111",
          cookId: csk.id,
          menuItemId: menu?.id,
          addressId: home?.id,
          mealType: "LUNCH",
          serviceDate: today,
          itemName: "Sambar Rice + Poriyal",
          itemNameTa: "சாம்பார் சாதம் + பொரியல்",
          qty: 1,
          foodPaise: 8000,
          deliveryPaise: 2500,
          platformFeePaise: 700,
          status: "DISPATCHED",
          deliveryTargetAddress: "Tower 3, Flat 1204, OMR Sholinganallur",
          channel: "WEB_STOREFRONT",
          gatewayTxnId: "mock_txn_LM-SEED01",
          idempotencyKey: `seed|${today}|rahul`,
        })
        .returning();

      await db.insert(payments).values({
        orderId: order.id,
        kind: "CHARGE",
        amountPaise: 10800,
        status: "CAPTURED",
        gatewayTxnId: "mock_txn_LM-SEED01",
        idempotencyKey: `pay|seed|${today}|rahul`,
      });

      await db.insert(supportTickets).values({
        orderId: order.id,
        cookId: csk.id,
        customerMobile: "+919840111111",
        category: "MISSING_DELIVERY",
        status: "OPEN",
        source: "WEB",
        summary: "Customer says lunch not received · PIN missing",
        slaDueAt: new Date(Date.now() + 35 * 60 * 1000),
      });
    }

    // EOD demo: one settleable DELIVERED + one held DELIVERED
    for (const fixture of [
      {
        publicId: "LM-SEED-OK",
        mobile: "+919840222222",
        hold: false,
        address: "Block B, Flat 501, Green Fields",
        key: `seed|${today}|eod-ok`,
      },
      {
        publicId: "LM-SEED-HOLD",
        mobile: "+919840111111",
        hold: true,
        address: "Tower 3, Flat 1204, OMR Sholinganallur",
        key: `seed|${today}|eod-hold`,
      },
    ]) {
      const exists = await db.query.orders.findFirst({
        where: eq(orders.publicId, fixture.publicId),
      });
      if (!exists) {
        await db.insert(orders).values({
          publicId: fixture.publicId,
          traceId: `trc_seed_${fixture.publicId.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
          customerMobile: fixture.mobile,
          cookId: csk.id,
          mealType: "LUNCH",
          serviceDate: today,
          itemName: "Sambar Rice + Poriyal",
          itemNameTa: "சாம்பார் சாதம் + பொரியல்",
          qty: 1,
          foodPaise: 8000,
          deliveryPaise: 2500,
          platformFeePaise: 700,
          status: "DELIVERED",
          settlementHold: fixture.hold,
          deliveryTargetAddress: fixture.address,
          channel: "WEB_STOREFRONT",
          gatewayTxnId: `mock_txn_${fixture.publicId}`,
          idempotencyKey: fixture.key,
        });
      }
    }
  }

  console.log("Seed complete for", today);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
