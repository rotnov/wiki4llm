"""Small, credential-free provenance shared by source, journal and publication."""

import re

from .config import RagError


def validate_origin(value):
    if not isinstance(value, dict):
        raise RagError("invalid file origin")
    if value.get("kind") == "git-lfs":
        if (
            set(value) != {"kind", "oid", "size"}
            or not isinstance(value["oid"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", value["oid"])
            or type(value["size"]) is not int
            or not 0 <= value["size"] <= 2**53 - 1
        ):
            raise RagError("invalid LFS origin")
    elif value.get("kind") == "generated":
        if (
            set(value) != {"kind", "recipe", "recipe_sha256", "inputs_sha256"}
            or not isinstance(value["recipe"], str)
            or len(value["recipe"]) > 80
            or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value["recipe"])
            or any(
                not isinstance(value[k], str) or not re.fullmatch(r"[a-f0-9]{64}", value[k])
                for k in ("recipe_sha256", "inputs_sha256")
            )
        ):
            raise RagError("invalid generated origin")
    else:
        raise RagError("unknown file origin")
    return value
