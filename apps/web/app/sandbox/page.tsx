import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import SandboxUI from "./SandboxUI";

export const dynamic = "force-dynamic";

export default async function SandboxPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    redirect("/login?next=/sandbox");
  }

  return (
    <main className="min-h-screen p-6">
      <header className="mx-auto flex max-w-5xl items-center justify-between pb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sandbox</h1>
          <p className="text-xs text-neutral-500">
            Signed in as {data.user.email ?? data.user.id}
          </p>
        </div>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="text-xs text-neutral-400 underline hover:text-neutral-200"
          >
            Sign out
          </button>
        </form>
      </header>
      <div className="mx-auto max-w-5xl">
        <SandboxUI />
      </div>
    </main>
  );
}
