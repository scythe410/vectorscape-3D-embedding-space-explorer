import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

import CinematicMount from "./CinematicMount";

export const dynamic = "force-dynamic";

export default async function SandboxCinematicPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    redirect(`/login?next=/sandbox/${id}/cinematic`);
  }
  return <CinematicMount projectId={id} />;
}
