"""CLI entry point. Every command defaults to local read-only inspection."""

import argparse
import json
import sys

from .config import RagError, load_config
from .engine import run


def main(argv=None):
    parser = argparse.ArgumentParser(prog="wiki-rag")
    parser.add_argument("--config", default="wiki-rag.toml", help="TOML config path")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "index", "update", "status"):
        child = commands.add_parser(name)
        child.add_argument("--config", default=argparse.SUPPRESS, help="TOML config path")
        if name in {"index", "update"}:
            child.add_argument(
                "--apply", action="store_true", help="explicitly enable remote writes"
            )
    args = parser.parse_args(argv)
    try:
        result = run(load_config(args.config), args.command, apply=getattr(args, "apply", False))
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except RagError as exc:
        print(f"wiki-rag: {exc}", file=sys.stderr)
        return 2
    except OSError:
        print(
            "wiki-rag: local I/O failed; durable state and publication preserved where possible",
            file=sys.stderr,
        )
        return 2
    except KeyboardInterrupt:
        print("wiki-rag: interrupted; rerun with durable state to reconcile", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
