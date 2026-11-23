import { Suspense } from "react";
import { api } from "@/lib/api";
import { KitchenBrowse, type KitchenWeekPayload } from "./KitchenBrowse";

export default async function KitchenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  let initialWeek: KitchenWeekPayload | null = null;
  try {
    initialWeek = await api<KitchenWeekPayload>(`/kitchens/${slug}/week?days=7&meal=LUNCH`);
  } catch {
    initialWeek = null;
  }

  return (
    <Suspense fallback={<p className="muted">Loading kitchen…</p>}>
      <KitchenBrowse slug={slug} initialWeek={initialWeek} />
    </Suspense>
  );
}
