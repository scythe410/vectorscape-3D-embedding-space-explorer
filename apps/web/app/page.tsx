import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  const target = data.user ? "/sandbox" : "/login?next=/sandbox";

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight">VectorScape</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Fly through your embeddings — soon.
        </p>
        <div className="mt-6">
          <Link
            href={target}
            className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
          >
            Open sandbox
          </Link>
        </div>
      </div>
    </main>
  );
}
