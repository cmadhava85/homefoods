/**
 * Seed ~1 month of daily menus for BREAKFAST / LUNCH / DINNER on all LIVE cooks.
 * Also enables all three meal periods in cook_meal_settings.
 *
 *   DATABASE_URL=… npm run seed:month -w @localmeals/db
 */
import { inArray } from "drizzle-orm";
import { createDb, closeDb } from "./client.js";
import { cookMealSettings, dailyMenus, orders } from "./schema.js";
import { defaultMealSchedule, MEAL_PERIODS, type MealPeriod } from "@localmeals/domain";

const DAYS = Number(process.env.SEED_MONTH_DAYS ?? 31);

const MENU_BY_MEAL: Record<
  MealPeriod,
  Array<{
    itemName: string;
    itemNameTa: string;
    pricePaise: number;
    isVeg: boolean;
    allergens: string[];
  }>
> = {
  BREAKFAST: [
    {
      itemName: "Idli (4) + Chutney",
      itemNameTa: "இட்லி (4) + சட்னி",
      pricePaise: 5000,
      isVeg: true,
      allergens: [],
    },
    {
      itemName: "Pongal + Vada",
      itemNameTa: "பொங்கல் + வடை",
      pricePaise: 6000,
      isVeg: true,
      allergens: [],
    },
  ],
  LUNCH: [
    {
      itemName: "Sambar Rice + Poriyal",
      itemNameTa: "சாம்பார் சாதம் + பொரியல்",
      pricePaise: 8000,
      isVeg: true,
      allergens: ["dairy"],
    },
    {
      itemName: "Chapathi (3) + Dal",
      itemNameTa: "சப்பாத்தி (3) + பருப்பு",
      pricePaise: 9000,
      isVeg: true,
      allergens: [],
    },
  ],
  DINNER: [
    {
      itemName: "Curd Rice + Pickle",
      itemNameTa: "தயிர் சாதம் + ஊறுகாய்",
      pricePaise: 7000,
      isVeg: true,
      allergens: ["dairy"],
    },
    {
      itemName: "Lemon Rice + Appalam",
      itemNameTa: "எலுமிச்சை சாதம் + அப்பளம்",
      pricePaise: 7500,
      isVeg: true,
      allergens: [],
    },
  ],
};

function addDaysISO(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const db = createDb();
  const start = new Date();
  start.setHours(12, 0, 0, 0); // avoid TZ edge on date-only
  const dates = Array.from({ length: DAYS }, (_, i) => addDaysISO(start, i));

  const cooks = await db.query.cookProfiles.findMany({
    where: (t, { eq: e, and: a }) => a(e(t.isActive, true), e(t.onboardingStatus, "LIVE")),
  });
  if (!cooks.length) {
    console.error("No LIVE active cooks — run npm run db:seed first");
    process.exit(1);
  }

  for (const cook of cooks) {
    for (const meal of MEAL_PERIODS) {
      const def = defaultMealSchedule(meal);
      await db
        .insert(cookMealSettings)
        .values({
          cookId: cook.id,
          mealType: meal,
          enabled: true,
          cutoffHour: def.cutoff.hour,
          cutoffMinute: def.cutoff.minute,
          deliveryStartHour: def.deliveryWindow.startHour,
          deliveryStartMinute: def.deliveryWindow.startMinute,
          deliveryEndHour: def.deliveryWindow.endHour,
          deliveryEndMinute: def.deliveryWindow.endMinute,
        })
        .onConflictDoUpdate({
          target: [cookMealSettings.cookId, cookMealSettings.mealType],
          set: {
            enabled: true,
            cutoffHour: def.cutoff.hour,
            cutoffMinute: def.cutoff.minute,
            deliveryStartHour: def.deliveryWindow.startHour,
            deliveryStartMinute: def.deliveryWindow.startMinute,
            deliveryEndHour: def.deliveryWindow.endHour,
            deliveryEndMinute: def.deliveryWindow.endMinute,
            updatedAt: new Date(),
          },
        });
    }
  }
  console.log(`Enabled BREAKFAST/LUNCH/DINNER for ${cooks.length} cook(s)`);

  const cookIds = cooks.map((c) => c.id);
  const startDate = dates[0]!;
  const endDate = dates[dates.length - 1]!;

  // Detach seed orders from menu rows so we can refresh the window safely
  const oldMenus = await db.query.dailyMenus.findMany({
    where: (t, { and: a, gte: g, lte: l, inArray: ia }) =>
      a(ia(t.cookId, cookIds), g(t.serviceDate, startDate), l(t.serviceDate, endDate)),
    columns: { id: true },
  });
  if (oldMenus.length) {
    await db
      .update(orders)
      .set({ menuItemId: null })
      .where(
        inArray(
          orders.menuItemId,
          oldMenus.map((m) => m.id),
        ),
      );
    await db.delete(dailyMenus).where(
      inArray(
        dailyMenus.id,
        oldMenus.map((m) => m.id),
      ),
    );
  }

  const rows: (typeof dailyMenus.$inferInsert)[] = [];
  for (const cook of cooks) {
    for (const serviceDate of dates) {
      for (const meal of MEAL_PERIODS) {
        const items = MENU_BY_MEAL[meal];
        // Rotate second item by weekday so week cart looks varied
        const dow = new Date(`${serviceDate}T12:00:00`).getDay();
        const picked = items.filter((_, idx) => idx === 0 || dow % 2 === idx % 2);
        for (const item of picked.length ? picked : items.slice(0, 1)) {
          rows.push({
            cookId: cook.id,
            itemName: item.itemName,
            itemNameTa: item.itemNameTa,
            pricePaise: item.pricePaise,
            serviceDate,
            mealType: meal,
            isVeg: item.isVeg,
            allergens: item.allergens,
            isAvailable: true,
            totalStockAvailable: 40,
          });
        }
      }
    }
  }

  const chunk = 200;
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(dailyMenus).values(rows.slice(i, i + chunk));
  }

  console.log(
    `Inserted ${rows.length} menu rows · ${dates[0]} → ${dates[dates.length - 1]} · meals=${MEAL_PERIODS.join(",")}`,
  );
  await closeDb(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
