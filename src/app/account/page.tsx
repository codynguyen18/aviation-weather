import { redirect } from "next/navigation";

import { auth } from "@/auth";
import AccountManager from "@/components/AccountManager";

export const dynamic = "force-dynamic";

// Account page (PLAN.md §17): saved building blocks and the hard-delete
// controls. Everything listed here belongs to the signed-in user only.
export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  return <AccountManager email={session.user.email ?? ""} />;
}
