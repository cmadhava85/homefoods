import { Suspense } from "react";
import { KitchenBrowse } from "./KitchenBrowse";

export default async function KitchenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <Suspense fallback={<p className="muted">Loading kitchen…</p>}>
      <KitchenBrowse slug={slug} />
    </Suspense>
  );
}
