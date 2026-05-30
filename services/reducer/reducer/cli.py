"""`python -m reducer.cli` entry point."""
from app.cli import cli, main

__all__ = ["cli", "main"]

if __name__ == "__main__":
    cli()
