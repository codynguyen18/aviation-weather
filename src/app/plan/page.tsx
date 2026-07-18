import { redirect } from "next/navigation";

import { auth } from "@/auth";
import PlanForm from "@/components/PlanForm";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  return <PlanForm />;
}
