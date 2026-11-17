import { KitchenBrowse } from "./KitchenBrowse";

export default async function KitchenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <KitchenBrowse slug={slug} />;
}
