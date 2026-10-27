#!/usr/bin/env python3
"""Generate sbom.cdx.json (CycloneDX 1.5) from the build inputs in this repo.

Sources:
  server/Cargo.lock          -> pkg:cargo components
  web/package-lock.json      -> pkg:npm components
  Containerfile FROM lines   -> pkg:oci components

Licenses for Rust crates come from the `.crate` archives in the local cargo
registry cache (their Cargo.toml), falling back to the license recorded for the
same crate in the previous sbom.cdx.json, then to NOASSERTION. Run it after a
dependency change:

    python3 scripts/gen_sbom.py

Set CARGO_HOME if the registry cache is not in ~/.cargo.
"""

import json
import os
import re
import sys
import tarfile
import tomllib
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SBOM = ROOT / "sbom.cdx.json"
APP_NAME = "lawbylaw"
APP_CRATE = "lawbylaw-server"
SERIAL_NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")


def previous_licenses() -> dict[tuple[str, str], str]:
    """Licenses recorded by the last generated SBOM, keyed by (ecosystem, name)."""
    if not SBOM.exists():
        return {}
    out = {}
    for comp in json.loads(SBOM.read_text()).get("components", []):
        ref = comp.get("bom-ref", "")
        eco = ref[4:].split("/")[0] if ref.startswith("pkg:") else ""
        lic = comp.get("licenses") or []
        if lic and "license" in lic[0]:
            value = lic[0]["license"].get("name") or lic[0]["license"].get("id")
            if value:
                out[(eco, comp["name"])] = value
    return out


def crate_licenses() -> dict[str, str]:
    """License string per crate name, read from the cargo registry cache."""
    home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    caches = list(home.glob("registry/cache/*"))
    # Also accept CARGO_HOME pointing straight at the registry directory (a
    # container volume mounted at /usr/local/cargo/registry, for example).
    caches += list(home.glob("cache/*"))
    out: dict[str, str] = {}
    for cache in caches:
        for archive in cache.glob("*.crate"):
            try:
                with tarfile.open(archive, "r:gz") as tar:
                    member = next(
                        (m for m in tar.getmembers() if m.name.endswith("/Cargo.toml")),
                        None,
                    )
                    if member is None:
                        continue
                    meta = tomllib.loads(tar.extractfile(member).read().decode())
            except (OSError, tarfile.TarError, tomllib.TOMLDecodeError):
                continue
            package = meta.get("package", {})
            name, lic = package.get("name"), package.get("license")
            if name and lic and name not in out:
                out[name] = lic
    return out


def cargo_components(prev: dict) -> list[dict]:
    text = (ROOT / "server/Cargo.lock").read_text()
    from_cache = crate_licenses()
    components = []
    for block in text.split("[[package]]")[1:]:
        name = re.search(r'^name = "([^"]+)"', block, re.M)
        version = re.search(r'^version = "([^"]+)"', block, re.M)
        if not name or not version:
            continue
        name, version = name.group(1), version.group(1)
        lic = from_cache.get(name) or prev.get(("cargo", name)) or "NOASSERTION"
        # Some crates still publish the legacy `A/B` form; SPDX wants `A OR B`.
        if "/" in lic and " OR " not in lic and " AND " not in lic:
            lic = " OR ".join(part.strip() for part in lic.split("/"))
        ref = f"pkg:cargo/{name}@{version}"
        comp = {
            "type": "library",
            "bom-ref": ref,
            "name": name,
            "version": version,
            "purl": ref,
            "licenses": [{"license": {"name": lic}}],
        }
        if name != APP_CRATE:
            comp["scope"] = "required"
        components.append(comp)
    return components


def npm_components(prev: dict) -> list[dict]:
    lock = json.loads((ROOT / "web/package-lock.json").read_text())
    packages = lock.get("packages", {})
    entries = {
        path: {**meta, "_name": meta.get("name") or path.split("node_modules/")[-1]}
        for path, meta in packages.items()
        if path and "node_modules/" in path and meta.get("version")
    }

    def resolve(name: str, from_path: str) -> str | None:
        """Node resolution: nearest node_modules, then walk up."""
        base = from_path
        while True:
            candidate = f"{base}/node_modules/{name}" if base else f"node_modules/{name}"
            if candidate in entries:
                return candidate
            if not base:
                return None
            base = base.rsplit("/node_modules/", 1)[0] if "/node_modules/" in base else ""

    # Runtime scope = reachable from the root "dependencies" (devDependencies and
    # their trees are build-only, so they are recorded as optional).
    required: set[str] = set()
    queue = [resolve(name, "") for name in packages.get("", {}).get("dependencies", {})]
    while queue:
        path = queue.pop()
        if not path or path in required:
            continue
        required.add(path)
        for dep in entries[path].get("dependencies", {}):
            queue.append(resolve(dep, path))

    components = []
    for path in sorted(entries, key=lambda p: entries[p]["_name"]):
        meta = entries[path]
        name, version = meta["_name"], meta["version"]
        ref = f"pkg:npm/{name}@{version}"
        comp = {
            "type": "library",
            "bom-ref": ref,
            "name": name,
            "version": version,
            "purl": ref,
            "scope": "required" if path in required else "optional",
        }
        lic = meta.get("license") or prev.get(("npm", name))
        if lic:
            comp["licenses"] = [{"license": {"name": lic}}]
        components.append(comp)
    return components


def oci_components() -> list[dict]:
    roles = {"web": "build-web", "server": "build-server", "": "runtime"}
    components = []
    for line in (ROOT / "Containerfile").read_text().splitlines():
        match = re.match(r"FROM\s+(\S+)(?:\s+AS\s+(\S+))?", line.strip(), re.I)
        if not match:
            continue
        image, stage = match.group(1), (match.group(2) or "").lower()
        name, _, tag = image.partition(":")
        tag = tag or "latest"
        ref = f"pkg:oci/{name}@{tag}"
        components.append(
            {
                "type": "container",
                "bom-ref": ref,
                "name": name,
                "version": tag,
                "purl": ref,
                "properties": [
                    {"name": "lawbylaw:role", "value": roles.get(stage, stage)}
                ],
            }
        )
    return components


def main() -> int:
    prev = previous_licenses()
    components = (
        sorted(cargo_components(prev), key=lambda c: (c["name"], c["version"]))
        + sorted(npm_components(prev), key=lambda c: (c["name"], c["version"]))
        + oci_components()
    )
    unknown = [c["bom-ref"] for c in components if c.get("licenses") == [{"license": {"name": "NOASSERTION"}}]]
    bom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid.uuid5(SERIAL_NAMESPACE, 'lawbylaw-sbom')}",
        "version": 1,
        "metadata": {
            "tools": [
                {"vendor": "lawbylaw", "name": "gen_sbom.py", "version": "2.0"}
            ],
            "component": {
                "type": "application",
                "bom-ref": f"pkg:cargo/{APP_CRATE}@0.1.0",
                "name": APP_NAME,
                "version": "0.1.0",
            },
        },
        "components": components,
    }
    SBOM.write_text(json.dumps(bom, indent=2) + "\n")
    by_eco: dict[str, int] = {}
    for comp in components:
        eco = comp["bom-ref"][4:].split("/")[0]
        by_eco[eco] = by_eco.get(eco, 0) + 1
    print(f"wrote {SBOM.relative_to(ROOT)}: {len(components)} components {by_eco}")
    if unknown:
        print(f"missing license metadata ({len(unknown)}): {', '.join(unknown)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
