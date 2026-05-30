"""Generate a small sample CSV with three thematic clusters."""
from __future__ import annotations

import csv
from pathlib import Path

CLUSTERS: dict[str, list[str]] = {
    "cooking": [
        "How long should I roast a whole chicken at 400 degrees",
        "Best technique for searing a ribeye steak in a cast iron pan",
        "Substitute for buttermilk in pancake batter",
        "Why do my chocolate chip cookies always come out flat",
        "How to knead bread dough without a stand mixer",
        "Tips for making fluffy scrambled eggs every morning",
        "How long does fresh pasta dough need to rest before rolling",
        "Best oil for deep frying chicken wings at home",
        "How to caramelize onions slowly without burning them",
        "Difference between baking powder and baking soda in recipes",
        "How to properly season a new cast iron skillet at home",
        "Why does my pizza dough not rise enough overnight",
        "Best way to poach an egg without it falling apart",
        "How long do you marinate chicken thighs before grilling",
        "Tips for making homemade ice cream without an ice cream maker",
        "How to brine a turkey before Thanksgiving for juicier meat",
        "Best technique for slicing onions without crying so much",
        "Why does my risotto always turn out gummy not creamy",
        "How to render bacon fat properly for cooking later",
        "Tips for making crispy roasted potatoes in the oven",
    ],
    "astronomy": [
        "How do black holes form from collapsing massive stars",
        "What is the Hubble tension and why does it matter",
        "Difference between dark matter and dark energy in cosmology",
        "How does gravitational lensing reveal hidden galaxies",
        "What can James Webb tell us about early universe galaxies",
        "Why is the cosmic microwave background so important to physics",
        "How do astronomers measure distances to nearby stars",
        "What happens at the event horizon of a supermassive black hole",
        "Are there really rogue planets drifting between the stars",
        "How does parallax help us measure the distance to stars",
        "Why are neutron stars some of the densest objects in the universe",
        "What creates the beautiful aurora seen near Earth's poles",
        "How long would it take to reach Proxima Centauri with current tech",
        "What is the difference between a meteor and a meteorite exactly",
        "Why do some galaxies have spiral arms while others are elliptical",
        "How do astronomers detect exoplanets around distant stars",
        "What is the great attractor pulling our galaxy across space",
        "Why do pulsars spin so fast after a supernova collapse",
        "How was the age of the universe estimated at 13.8 billion years",
        "What would happen if a gamma ray burst hit Earth tomorrow",
    ],
    "programming": [
        "When should I use TypeScript instead of plain JavaScript",
        "Best way to structure a Next.js app with the App Router",
        "How to debounce input events in React without lag",
        "Difference between useEffect and useLayoutEffect in React",
        "How to handle authentication securely in a Node.js backend",
        "Tips for writing fast SQL queries on large Postgres tables",
        "Why is my React component re-rendering so many times",
        "How to set up a monorepo with bun workspaces from scratch",
        "Best practices for error handling in async Python code",
        "How does the Rust borrow checker prevent memory bugs at compile time",
        "When to choose Postgres over MongoDB for a new project",
        "Why does my Docker image keep getting so large to deploy",
        "How to handle race conditions in a Go program with goroutines",
        "Best way to cache API responses in a Next.js application",
        "Tips for reducing bundle size in a large React application",
        "How to write good unit tests for an Express API endpoint",
        "Difference between SSR and SSG in Next.js page rendering",
        "How to migrate a JavaScript codebase to TypeScript incrementally",
        "Best practices for managing secrets in a Node.js production app",
        "Why does my Python script run faster with NumPy than pure loops",
    ],
}


def main() -> None:
    out = Path(__file__).parent / "sample.csv"
    rows = []
    for cluster, items in CLUSTERS.items():
        for body in items:
            rows.append({"id": len(rows) + 1, "topic": cluster, "body": body})
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "topic", "body"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows -> {out}")


if __name__ == "__main__":
    main()
