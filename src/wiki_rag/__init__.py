"""Incremental documentation ingestion."""

from .cli import main
from .config import RagError, load_config
from .engine import run
from .provider import OpenAIProvider
from .selection import scan
from .state import is_active, read_manifest

__all__ = [
    "RagError",
    "load_config",
    "scan",
    "run",
    "read_manifest",
    "is_active",
    "OpenAIProvider",
    "main",
]
