"""Build the SKM demo CSV from the 20 Newsgroups corpus.

20 Newsgroups ships with scikit-learn and downloads once to
~/scikit_learn_data on first use. It has 20 hand-curated topical
categories — a classic embedding-visualization corpus that gives a
visibly clustered galaxy without any tuning.

We strip headers/footers/quotes (so embeddings reflect content, not
boilerplate), truncate each post to the first ~600 chars (long-tail
posts dilute the MiniLM signal and bloat the wire payload), and drop
empty/very-short posts.
"""
from __future__ import annotations

import csv
import random
from pathlib import Path

from sklearn.datasets import fetch_20newsgroups

MAX_CHARS = 600
MIN_CHARS = 40
PER_CATEGORY = 400  # 20 categories × 400 ≈ 8000 rows — dense galaxy, fast bake


def main() -> None:
    bundle = fetch_20newsgroups(
        subset="train",
        remove=("headers", "footers", "quotes"),
        shuffle=False,
    )

    rng = random.Random(0xC0FFEE)
    by_cat: dict[str, list[str]] = {name: [] for name in bundle.target_names}
    for raw, label_idx in zip(bundle.data, bundle.target, strict=False):
        body = " ".join(str(raw).split())
        if len(body) < MIN_CHARS:
            continue
        if len(body) > MAX_CHARS:
            body = body[:MAX_CHARS].rsplit(" ", 1)[0] + "…"
        by_cat[bundle.target_names[label_idx]].append(body)

    rows: list[dict[str, str]] = []
    for cat in bundle.target_names:
        items = by_cat[cat]
        rng.shuffle(items)
        for body in items[:PER_CATEGORY]:
            rows.append({"id": str(len(rows) + 1), "category": cat, "body": body})

    out = Path(__file__).parent / "demo.csv"
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "category", "body"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows across {len(bundle.target_names)} categories -> {out}")


if __name__ == "__main__":
    main()
