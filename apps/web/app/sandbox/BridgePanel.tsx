"use client";

import type { VectorScapeHandle } from "engine";
import { useCallback, useEffect, useRef, useState } from "react";

import { clusterColor, type ClusterRow } from "./loadProject";

type LLMStatus = {
  provider: "openai" | "gemini" | "none";
  model: string;
  may_train_on_data: boolean;
};

// localStorage key for the Gemini-training consent flag. Tied to the provider
// so if we later add another may-train backend, it gets its own gate.
const GEMINI_CONSENT_KEY = "vectorscape:bridge-consent:gemini";

type BridgeExample = {
  id: string;
  text: string;
  cluster_id: number;
  x: number;
  y: number;
  z: number;
  role: "medoid" | "boundary";
};

type BridgeResult = {
  summary: string;
  cluster_a: { cluster_id: number; label: string; size: number };
  cluster_b: { cluster_id: number; label: string; size: number };
  examples_a: BridgeExample[];
  examples_b: BridgeExample[];
  model: string;
};

interface Props {
  projectId: string;
  selection: number[];
  clusters: ClusterRow[];
  handleRef: React.RefObject<VectorScapeHandle | null>;
  onClear: () => void;
}

type State =
  | { kind: "idle" }
  | { kind: "loading"; a: number; b: number }
  | { kind: "ready"; a: number; b: number; result: BridgeResult }
  | { kind: "error"; a: number; b: number; message: string };

export default function BridgePanel({
  projectId,
  selection,
  clusters,
  handleRef,
  onClear,
}: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  // Track the most recent fetch so a stale response from a previous selection
  // doesn't clobber the current one.
  const reqIdRef = useRef(0);

  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null);
  // `null` = not fetched yet, `"ok"` = fetched, `"failed"` = fetch errored.
  // Distinguishing the unknown-vs-failed states lets us pause the auto-fire
  // for users who might otherwise hit a may-train backend without seeing
  // the consent prompt.
  const [llmStatusState, setLlmStatusState] = useState<
    "unknown" | "ok" | "failed"
  >("unknown");
  const [consented, setConsented] = useState(false);

  // Pull provider info once; the user can't change it from the UI.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/llm-status", { cache: "no-store" });
        if (cancelled) return;
        if (!r.ok) {
          setLlmStatusState("failed");
          return;
        }
        const body = (await r.json()) as LLMStatus;
        if (cancelled) return;
        setLlmStatus(body);
        setLlmStatusState("ok");
      } catch {
        // If we can't tell which provider is live, we cannot prove the
        // consent gate is unnecessary — keep the panel paused and let the
        // user decide. Better than silently shipping data to a may-train
        // backend.
        if (!cancelled) setLlmStatusState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Read prior consent from localStorage once we know which provider is live.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (llmStatus?.provider === "gemini") {
      setConsented(window.localStorage.getItem(GEMINI_CONSENT_KEY) === "1");
    } else {
      setConsented(false);
    }
  }, [llmStatus?.provider]);

  const needsConsent =
    llmStatus?.may_train_on_data === true && !consented;

  // When llm-status failed we don't know whether the active backend trains
  // on data — pause auto-bridge until the user opts in via the explicit
  // notice. Mirrors the consent-gate behavior but for the "unknown" path.
  const statusFailed = llmStatusState === "failed" && !consented;

  const grantConsent = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(GEMINI_CONSENT_KEY, "1");
    }
    setConsented(true);
  }, []);

  const runBridge = useCallback(
    async (a: number, b: number) => {
      const myReq = ++reqIdRef.current;
      setState({ kind: "loading", a, b });
      try {
        const r = await fetch(`/api/projects/${projectId}/bridge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cluster_a: a, cluster_b: b }),
        });
        const body = (await r.json()) as BridgeResult | { error: string };
        if (myReq !== reqIdRef.current) return;
        if (!r.ok) {
          const message = "error" in body ? body.error : `HTTP ${r.status}`;
          setState({ kind: "error", a, b, message });
          return;
        }
        setState({ kind: "ready", a, b, result: body as BridgeResult });
      } catch (e) {
        if (myReq !== reqIdRef.current) return;
        const message = e instanceof Error ? e.message : "network error";
        setState({ kind: "error", a, b, message });
      }
    },
    [projectId],
  );

  // Auto-fetch when two clusters are selected. Re-fires when the pair changes.
  // Skip while a consent gate is pending — the user clicks through it to fire.
  useEffect(() => {
    if (selection.length !== 2) {
      setState({ kind: "idle" });
      reqIdRef.current++;
      return;
    }
    if (needsConsent || statusFailed) {
      setState({ kind: "idle" });
      return;
    }
    const [a, b] = selection;
    void runBridge(a, b);
  }, [selection, runBridge, needsConsent, statusFailed]);

  const onCitedClick = (ex: BridgeExample) => {
    handleRef.current?.flyToPoint([ex.x, ex.y, ex.z], 2.5);
  };

  const aLabel = (id: number) =>
    clusters.find((c) => c.cluster_id === id)?.label ?? `Cluster ${id}`;

  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
      <header className="flex items-center justify-between border-b border-neutral-900 px-3 py-2 text-xs uppercase tracking-wider text-neutral-400">
        <span>Bridge</span>
        {selection.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-neutral-500 hover:text-neutral-300"
          >
            clear
          </button>
        )}
      </header>

      <div className="scrollbar-subtle flex-1 overflow-y-auto px-3 py-2 text-sm">
        {selection.length === 0 && (
          <div className="text-xs text-neutral-500">
            Shift-click two clusters to explain the shared theme and the
            contrast between them.
          </div>
        )}

        {selection.length === 1 && (
          <div className="space-y-1.5">
            <SelectionChips selection={selection} labelFor={aLabel} />
            <div className="text-xs text-neutral-500">
              Shift-click a second cluster to bridge.
            </div>
          </div>
        )}

        {selection.length === 2 && (
          <div className="space-y-3">
            <SelectionChips selection={selection} labelFor={aLabel} />

            {needsConsent && (
              <GeminiConsentGate
                model={llmStatus?.model ?? "gemini-2.5-flash"}
                onAccept={grantConsent}
              />
            )}
            {!needsConsent && statusFailed && (
              <LLMStatusUnknownGate onContinue={grantConsent} />
            )}
            {!needsConsent && !statusFailed && state.kind === "loading" && (
              <div className="text-xs text-neutral-500">
                Pulling medoids and boundary points…
              </div>
            )}
            {!needsConsent && !statusFailed && state.kind === "error" && (
              <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                {state.message}
              </div>
            )}
            {!needsConsent && !statusFailed && state.kind === "ready" && (
              <BridgeReadout
                result={state.result}
                onCitedClick={onCitedClick}
              />
            )}
            {!needsConsent && !statusFailed && llmStatus?.may_train_on_data === true && (
              <TrainingDataFootnote model={llmStatus.model} />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function GeminiConsentGate({
  model,
  onAccept,
}: {
  model: string;
  onAccept: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
      <div className="font-medium text-amber-200">
        Heads up — free-tier AI in use
      </div>
      <p className="leading-relaxed text-amber-100/90">
        No paid LLM key is configured, so summaries run through Google AI
        Studio&apos;s free tier ({model}). Per Google&apos;s terms, inputs on
        the free tier may be used to improve their models. We send a handful
        of short text snippets from the two selected clusters — medoid plus
        boundary points.
      </p>
      <p className="leading-relaxed text-amber-100/80">
        Don&apos;t bridge clusters from confidential or personal data unless
        you&apos;re OK with that.
      </p>
      <button
        type="button"
        onClick={onAccept}
        className="mt-1 rounded-md border border-amber-700/60 bg-amber-900/40 px-2 py-1 text-[11px] font-medium text-amber-100 hover:bg-amber-900/70"
      >
        I understand — continue
      </button>
    </div>
  );
}

function LLMStatusUnknownGate({ onContinue }: { onContinue: () => void }) {
  // The /api/llm-status fetch failed. We can't tell whether the active
  // backend is OpenAI (no-train), Gemini free-tier (may-train), or the
  // no-key fallback. Pre-audit, this branch silently disabled the consent
  // gate — a user clicking Bridge could send data to a may-train backend
  // without seeing the prompt. This gate makes the unknown state loud.
  return (
    <div className="space-y-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
      <div className="font-medium text-amber-200">
        LLM status unknown
      </div>
      <p className="leading-relaxed text-amber-100/90">
        We couldn&apos;t reach the LLM-status endpoint, so we don&apos;t know
        which provider would summarize your bridge. If the active backend is
        a may-train free tier (e.g. Google AI Studio), the cluster snippets
        we send could be used to improve models. Don&apos;t bridge
        confidential data from this state.
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="mt-1 rounded-md border border-amber-700/60 bg-amber-900/40 px-2 py-1 text-[11px] font-medium text-amber-100 hover:bg-amber-900/70"
      >
        I understand — continue anyway
      </button>
    </div>
  );
}

function TrainingDataFootnote({ model }: { model: string }) {
  return (
    <div className="text-[10px] leading-snug text-amber-200/70">
      Summarized via {model} (free tier) — inputs may be used by Google to
      improve their models.
    </div>
  );
}

function SelectionChips({
  selection,
  labelFor,
}: {
  selection: number[];
  labelFor: (id: number) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selection.map((id, i) => {
        const rgb = clusterColor(id);
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-black/40 px-1.5 py-0.5 text-xs text-neutral-200"
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{
                background: `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`,
              }}
            />
            <span className="truncate max-w-[14ch]">{labelFor(id)}</span>
            {i === 0 && selection.length === 2 && (
              <span className="text-neutral-500">⟷</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function BridgeReadout({
  result,
  onCitedClick,
}: {
  result: BridgeResult;
  onCitedClick: (ex: BridgeExample) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="whitespace-pre-wrap text-neutral-200">
        {result.summary}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-600">
        cited · {result.model}
      </div>
      <div className="grid grid-cols-1 gap-2">
        <CitedColumn
          title={result.cluster_a.label}
          clusterId={result.cluster_a.cluster_id}
          examples={result.examples_a}
          onCitedClick={onCitedClick}
        />
        <CitedColumn
          title={result.cluster_b.label}
          clusterId={result.cluster_b.cluster_id}
          examples={result.examples_b}
          onCitedClick={onCitedClick}
        />
      </div>
    </div>
  );
}

function CitedColumn({
  title,
  clusterId,
  examples,
  onCitedClick,
}: {
  title: string;
  clusterId: number;
  examples: BridgeExample[];
  onCitedClick: (ex: BridgeExample) => void;
}) {
  const rgb = clusterColor(clusterId);
  return (
    <div className="rounded-md border border-neutral-900 bg-black/30">
      <div className="flex items-center gap-1.5 border-b border-neutral-900 px-2 py-1 text-xs text-neutral-300">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm"
          style={{
            background: `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`,
          }}
        />
        <span className="truncate">{title}</span>
      </div>
      <ul className="divide-y divide-neutral-900">
        {examples.map((ex) => (
          <li key={ex.id}>
            <button
              type="button"
              onClick={() => onCitedClick(ex)}
              className="block w-full px-2 py-1.5 text-left hover:bg-neutral-900/60"
              title="Fly the camera to this point"
            >
              <div className="mb-0.5 flex items-center justify-between">
                <span
                  className={
                    ex.role === "boundary"
                      ? "text-[10px] uppercase tracking-wider text-amber-300/90"
                      : "text-[10px] uppercase tracking-wider text-neutral-500"
                  }
                >
                  {ex.role}
                </span>
                <span className="font-mono text-[10px] text-neutral-600">
                  ↪ fly
                </span>
              </div>
              <div className="line-clamp-3 text-xs text-neutral-300">
                {ex.text}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
