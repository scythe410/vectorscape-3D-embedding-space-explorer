"""Generate a >10k-row CSV for exercising the arq worker path.

Uses a small pool of seed texts repeated many times so the embedding
cache makes the run cheap on rerun (and the first run only needs to
embed |seeds| unique strings).
"""
from __future__ import annotations

import csv
import random
from pathlib import Path

SEEDS = [
    "homemade sourdough bread baking guide and recipe",
    "best knife sharpening techniques for kitchen blades",
    "slow cooker beef stew with red wine reduction",
    "pasta carbonara authentic roman recipe with guanciale",
    "vegetarian curry with chickpeas and coconut milk",
    "supernova remnant observed in the crab nebula",
    "exoplanet discovery via transit photometry method",
    "black hole accretion disk thermal emission spectrum",
    "galaxy rotation curves and dark matter halo evidence",
    "cosmic microwave background polarization measurements",
    "python decorators explained with practical examples",
    "rust ownership and borrowing fundamentals tutorial",
    "kubernetes pod networking and service discovery",
    "react server components vs client components rendering",
    "postgres query plan analysis and index optimization",
]

N = 10_500


def main() -> None:
    rng = random.Random(0)
    out = Path(__file__).resolve().parent / "large.csv"
    with out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "body"])
        for i in range(N):
            seed = SEEDS[rng.randrange(len(SEEDS))]
            w.writerow([i, seed])
    print(f"wrote {out} with {N} rows, {len(SEEDS)} unique texts")


if __name__ == "__main__":
    main()
