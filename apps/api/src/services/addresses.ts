import { and, eq } from "drizzle-orm";
import { addresses, users, type Db } from "@localmeals/db";
import { resolveAddressLatLng } from "@localmeals/domain";

export type AddressLabel = "HOME" | "OFFICE" | "OTHER";

function normalizeMobile(mobile: string) {
  const digits = mobile.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (mobile.startsWith("+") && digits.length >= 10) return `+${digits}`;
  throw new Error("Enter a valid Indian mobile number");
}

function normalizePin(pin: string) {
  const p = pin.replace(/\D/g, "").slice(0, 6);
  if (p.length !== 6) throw new Error("PIN code must be 6 digits");
  return p;
}

/** Store trusted coords (PIN-anchored); reject GPS that drifts far from known PIN. */
function resolveStoredCoords(input: {
  pinCode: string;
  lat?: string | number | null;
  lng?: string | number | null;
}): { lat: string | null; lng: string | null } {
  const trusted = resolveAddressLatLng({
    pinCode: input.pinCode,
    lat: input.lat,
    lng: input.lng,
  });
  if (!trusted) return { lat: null, lng: null };
  return { lat: trusted.lat.toFixed(7), lng: trusted.lng.toFixed(7) };
}

export async function listAddressesForMobile(db: Db, mobile: string) {
  const userMobile = normalizeMobile(mobile);
  const rows = await db.query.addresses.findMany({
    where: (t, { eq: e }) => e(t.userMobile, userMobile),
  });
  return rows
    .slice()
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id)
    .map((r) => ({
      id: r.id,
      label: r.label as AddressLabel,
      line1: r.line1,
      line2: r.line2,
      pinCode: r.pinCode,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      isDefault: r.isDefault,
    }));
}

export async function getAddressForUser(db: Db, mobile: string, addressId: number) {
  const userMobile = normalizeMobile(mobile);
  const row = await db.query.addresses.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.id, addressId), e(t.userMobile, userMobile)),
  });
  if (!row) throw new Error("Choose a delivery address from your saved list");
  return row;
}

export async function getAddressByLabel(db: Db, mobile: string, label: AddressLabel) {
  const userMobile = normalizeMobile(mobile);
  const row = await db.query.addresses.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.userMobile, userMobile), e(t.label, label)),
  });
  if (!row) {
    throw new Error(
      `No ${label.toLowerCase()} address saved. Reply: Save ${label} <your full address>`,
    );
  }
  return row;
}

export async function createAddress(
  db: Db,
  input: {
    mobile: string;
    label: AddressLabel;
    line1: string;
    line2?: string | null;
    pinCode: string;
    lat?: string | number | null;
    lng?: string | number | null;
    isDefault?: boolean;
  },
) {
  const userMobile = normalizeMobile(input.mobile);
  const line1 = input.line1.trim();
  if (line1.length < 5) throw new Error("Enter a fuller address (tower / flat / street)");
  const pinCode = normalizePin(input.pinCode);
  const label = input.label;
  const coords = resolveStoredCoords({
    pinCode,
    lat: input.lat,
    lng: input.lng,
  });

  const existing = await db.query.addresses.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.userMobile, userMobile), e(t.label, label)),
  });
  if (existing) {
    throw new Error(
      `You already have a ${label.toLowerCase()} address — pick it at checkout or revoke and re-add later`,
    );
  }

  const makeDefault = Boolean(input.isDefault);
  return db.transaction(async (tx) => {
    // WA "Save HOME …" can arrive before OTP login — ensure FK parent exists
    const existingUser = await tx.query.users.findFirst({
      where: (t, { eq: e }) => e(t.mobileNumber, userMobile),
    });
    if (!existingUser) {
      await tx.insert(users).values({
        mobileNumber: userMobile,
        fullName: "Guest",
        primaryAddress: line1,
        pinCode,
        segment: "BACHELOR",
      });
    }

    if (makeDefault) {
      await tx
        .update(addresses)
        .set({ isDefault: false })
        .where(eq(addresses.userMobile, userMobile));
    }
    const [row] = await tx
      .insert(addresses)
      .values({
        userMobile,
        label,
        line1,
        line2: input.line2?.trim() || null,
        pinCode,
        lat: coords.lat,
        lng: coords.lng,
        isDefault: makeDefault,
      })
      .returning();
    return {
      id: row.id,
      label: row.label as AddressLabel,
      line1: row.line1,
      line2: row.line2,
      pinCode: row.pinCode,
      lat: row.lat ?? null,
      lng: row.lng ?? null,
      isDefault: row.isDefault,
    };
  });
}

export async function updateAddress(
  db: Db,
  input: {
    mobile: string;
    addressId: number;
    line1?: string;
    line2?: string | null;
    pinCode?: string;
    lat?: string | number | null;
    lng?: string | number | null;
    isDefault?: boolean;
  },
) {
  const userMobile = normalizeMobile(input.mobile);
  const row = await getAddressForUser(db, userMobile, input.addressId);
  const patch: Partial<typeof addresses.$inferInsert> = {};
  if (input.line1 != null) {
    const line1 = input.line1.trim();
    if (line1.length < 5) throw new Error("Enter a fuller address (tower / flat / street)");
    patch.line1 = line1;
  }
  if (input.line2 !== undefined) patch.line2 = input.line2?.trim() || null;
  if (input.pinCode != null) patch.pinCode = normalizePin(input.pinCode);

  const nextPin = patch.pinCode ?? row.pinCode;
  if (input.lat !== undefined || input.lng !== undefined) {
    const coords = resolveStoredCoords({
      pinCode: nextPin,
      lat: input.lat,
      lng: input.lng,
    });
    patch.lat = coords.lat;
    patch.lng = coords.lng;
  } else if (input.pinCode != null && (!row.lat || !row.lng)) {
    const coords = resolveStoredCoords({ pinCode: nextPin });
    patch.lat = coords.lat;
    patch.lng = coords.lng;
  }

  return db.transaction(async (tx) => {
    if (input.isDefault === true) {
      await tx
        .update(addresses)
        .set({ isDefault: false })
        .where(and(eq(addresses.userMobile, userMobile), eq(addresses.isDefault, true)));
      patch.isDefault = true;
    }
    const [updated] = await tx
      .update(addresses)
      .set(patch)
      .where(eq(addresses.id, row.id))
      .returning();
    return {
      id: updated.id,
      label: updated.label as AddressLabel,
      line1: updated.line1,
      line2: updated.line2,
      pinCode: updated.pinCode,
      lat: updated.lat ?? null,
      lng: updated.lng ?? null,
      isDefault: updated.isDefault,
    };
  });
}
