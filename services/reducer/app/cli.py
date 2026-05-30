"""CLI harness: python -m app.cli sample.csv --text-column body."""
from __future__ import annotations

import sys
import time
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


def main() -> None:
    cli()


if __name__ == "__main__":
    sys.exit(cli() or 0)
