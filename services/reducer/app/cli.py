"""CLI harness: python -m app.cli sample.csv --text-column body."""
from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

import pandas as pd
import typer

from .config import DEFAULT_EMBED_MODEL, DEFAULT_REDUCER
from .db import connect, ensure_project, set_status, write_results
from .pipeline import run_pipeline

cli = typer.Typer(add_completion=False, no_args_is_help=True)


@cli.command()
def run(
    csv_path: Path = typer.Argument(..., exists=True, readable=True),  # noqa: B008
    text_column: str = typer.Option(..., "--text-column", "-t"),  # noqa: B008
    name: str = typer.Option("cli-run", "--name", "-n"),  # noqa: B008
    embed_model: str = typer.Option(DEFAULT_EMBED_MODEL, "--embed-model"),  # noqa: B008
    reducer: str = typer.Option(DEFAULT_REDUCER, "--reducer"),  # noqa: B008
    project_id: str | None = typer.Option(None, "--project-id"),  # noqa: B008
    tenant_id: str | None = typer.Option(None, "--tenant-id"),  # noqa: B008
    limit: int | None = typer.Option(None, "--limit", help="Truncate CSV to N rows"),  # noqa: B008
) -> None:
    """Run the full pipeline against the cloud DB and print a summary."""
    df = pd.read_csv(csv_path)
    if text_column not in df.columns:
        typer.echo(f"error: text_column '{text_column}' not in {list(df.columns)}", err=True)
        raise typer.Exit(code=2)

    if limit:
        df = df.head(limit)

    texts = [str(v) for v in df[text_column].tolist() if v is not None and str(v).strip() != ""]
    if not texts:
        typer.echo("error: no non-empty text rows", err=True)
        raise typer.Exit(code=2)

    typer.echo(f"loaded {len(texts)} rows from {csv_path}")
    t0 = time.perf_counter()

    with connect() as conn:
        pid, tid = ensure_project(
            conn,
            project_id=project_id,
            name=name,
            embed_model=embed_model,
            reducer=reducer,
            tenant_id=tenant_id,
        )
        typer.echo(f"project_id={pid} tenant_id={tid}")
        try:
            result = run_pipeline(texts, embed_model=embed_model, reducer=reducer)
            summary = write_results(
                conn, project_id=pid, tenant_id=tid, texts=texts, result=result
            )
        except Exception as e:
            set_status(conn, pid, "error")
            typer.echo(f"error: pipeline failed: {e}", err=True)
            raise

    elapsed = time.perf_counter() - t0
    typer.echo("---")
    typer.echo(f"n_points    : {summary['n_points']}")
    typer.echo(f"n_clusters  : {summary['n_clusters']}")
    typer.echo(f"n_noise     : {summary['n_noise']}")
    typer.echo(f"used_pca    : {summary['used_pca']}")
    typer.echo(f"reducer     : {summary['reducer']}")
    typer.echo(f"embed_model : {summary['embed_model']}")
    typer.echo(f"runtime     : {elapsed:.2f}s")
    typer.echo(f"project_id  : {summary['project_id']}")


@cli.command("bake-static")
def bake_static(
    csv_path: Path = typer.Argument(..., exists=True, readable=True),  # noqa: B008
    out_path: Path = typer.Option(..., "--out", "-o"),  # noqa: B008
    text_column: str = typer.Option(..., "--text-column", "-t"),  # noqa: B008
    name: str = typer.Option("Demo galaxy", "--name", "-n"),  # noqa: B008
    embed_model: str = typer.Option(DEFAULT_EMBED_MODEL, "--embed-model"),  # noqa: B008
    reducer: str = typer.Option(DEFAULT_REDUCER, "--reducer"),  # noqa: B008
    label_column: str | None = typer.Option(  # noqa: B008
        None, "--label-column", help="CSV column to use as a per-cluster label hint (majority vote)"
    ),
    min_cluster_size: int | None = typer.Option(  # noqa: B008
        None, "--min-cluster-size", help="HDBSCAN min_cluster_size override"
    ),
    cluster_method: str = typer.Option(  # noqa: B008
        "eom", "--cluster-method", help="HDBSCAN cluster_selection_method (eom or leaf)"
    ),
    limit: int | None = typer.Option(None, "--limit"),  # noqa: B008
) -> None:
    """Bake the pipeline output to a static JSON file (skips the DB).

    The payload matches the shape of `/api/projects/[id]/data` JSON so the web
    app's existing loadProject helper consumes it unchanged. Use this for the
    permanently-ready demo project.
    """
    df = pd.read_csv(csv_path)
    if text_column not in df.columns:
        typer.echo(f"error: text_column '{text_column}' not in {list(df.columns)}", err=True)
        raise typer.Exit(code=2)
    if limit:
        df = df.head(limit)

    mask = df[text_column].notna() & (df[text_column].astype(str).str.strip() != "")
    df = df.loc[mask].reset_index(drop=True)
    texts = [str(v) for v in df[text_column].tolist()]
    if not texts:
        typer.echo("error: no non-empty text rows", err=True)
        raise typer.Exit(code=2)

    labels = (
        [str(v) for v in df[label_column].tolist()] if label_column and label_column in df.columns
        else None
    )

    typer.echo(f"loaded {len(texts)} rows from {csv_path}")
    t0 = time.perf_counter()
    result = run_pipeline(
        texts,
        embed_model=embed_model,
        reducer=reducer,
        min_cluster_size=min_cluster_size,
        cluster_selection_method=cluster_method,
    )
    elapsed = time.perf_counter() - t0

    # Pre-mint stable UUIDs so future references (e.g. medoid_point_id) survive
    # round-trips through the static file.
    point_ids = [str(uuid.uuid4()) for _ in range(len(texts))]
    project_id = str(uuid.uuid4())

    cluster_label_hints: dict[int, str] = {}
    if labels is not None:
        from collections import Counter
        for c in result.clusters:
            members = [labels[i] for i in range(len(texts)) if int(result.cluster_ids[i]) == c.cluster_id]
            if members:
                top, _ = Counter(members).most_common(1)[0]
                cluster_label_hints[c.cluster_id] = top

    points_json = []
    for i, text in enumerate(texts):
        cid = int(result.cluster_ids[i])
        points_json.append({
            "id": point_ids[i],
            "text": text,
            "x": float(result.coords[i, 0]),
            "y": float(result.coords[i, 1]),
            "z": float(result.coords[i, 2]),
            "cluster_id": cid if cid != -1 else None,
            "cluster_probability": float(result.cluster_probabilities[i]),
        })

    clusters_json = [
        {
            "cluster_id": c.cluster_id,
            "label": cluster_label_hints.get(c.cluster_id, c.label),
            "cx": c.cx,
            "cy": c.cy,
            "cz": c.cz,
            "size": c.size,
            "medoid_point_id": point_ids[c.medoid_index],
        }
        for c in result.clusters
    ]

    payload = {
        "project": {
            "id": project_id,
            "name": name,
            "point_count": len(texts),
        },
        "points": points_json,
        "clusters": clusters_json,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    size_mb = out_path.stat().st_size / (1024 * 1024)
    n_noise = int((result.cluster_ids == -1).sum())
    typer.echo("---")
    typer.echo(f"n_points   : {len(texts)}")
    typer.echo(f"n_clusters : {len(result.clusters)}")
    typer.echo(f"n_noise    : {n_noise}")
    typer.echo(f"used_pca   : {result.used_pca}")
    typer.echo(f"reducer    : {result.reducer}")
    typer.echo(f"runtime    : {elapsed:.2f}s")
    typer.echo(f"wrote      : {out_path} ({size_mb:.2f} MiB)")


def main() -> None:
    cli()


if __name__ == "__main__":
    sys.exit(cli() or 0)
