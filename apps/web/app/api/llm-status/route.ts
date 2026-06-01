import { NextResponse } from "next/server";
import { ReducerConfigError, reducerHeaders, reducerUrl } from "@/lib/reducer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export type LLMStatus = {
  provider: "openai" | "gemini" | "none";
  model: string;
  may_train_on_data: boolean;
};

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let reducerResp: Response;
  try {
    reducerResp = await fetch(reducerUrl("/llm-status"), {
      method: "GET",
      headers: reducerHeaders(),
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof ReducerConfigError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `reducer unreachable (${msg})` },
      { status: 502 },
    );
  }
  const text = await reducerResp.text();
  if (!reducerResp.ok) {
    return NextResponse.json(
      { error: `reducer llm-status failed: ${text.slice(0, 300)}` },
      { status: reducerResp.status },
    );
  }
  return new NextResponse(text, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
