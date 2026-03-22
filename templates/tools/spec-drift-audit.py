#!/usr/bin/env python3
"""
Level 5 Spec-Drift Audit Tool

Compares FR requirements defined in Specifications/ against // Verifies: comments in Source/.
Supports an alias map to resolve legacy FR IDs (FR-001) to canonical IDs (FR-AC-001).

Usage:
    python3 tools/spec-drift-audit.py
    python3 tools/spec-drift-audit.py --aliases tools/fr-aliases.json
"""
import os
import re
import json
import sys
from pathlib import Path

ALIAS_FILE = "tools/fr-aliases.json"


def load_aliases(alias_path: str) -> dict[str, str]:
    """Load FR ID alias map: legacy_id -> canonical_id."""
    path = Path(alias_path)
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        print(f"Warning: Could not load alias file {alias_path}", file=sys.stderr)
        return {}


def extract_frs_from_specs():
    """Scans Specifications/ for all FR-XXX patterns. Returns canonical FRs only."""
    spec_dir = Path("Specifications")
    frs_in_specs = set()

    if not spec_dir.exists():
        return frs_in_specs

    # Match canonical FR IDs: FR-XX-NNN (domain-prefixed, e.g., FR-AC-001, FR-EM-008, FR-DR-016)
    canonical_pattern = re.compile(r"FR-[A-Z]{2,4}-\d{3}")
    # Also match any FR-like pattern for the "all FRs" count
    any_fr_pattern = re.compile(r"FR-[A-Z0-9]+-?\d*")

    for root, _, files in os.walk(spec_dir):
        for file in files:
            if file.endswith(".md"):
                f_path = Path(root) / file
                try:
                    content = f_path.read_text(encoding="utf-8")
                    # Only count canonical FRs as the ground truth
                    found = canonical_pattern.findall(content)
                    frs_in_specs.update(found)
                except OSError:
                    continue

    return frs_in_specs


def extract_verified_frs(aliases: dict[str, str]):
    """Scans Source/ for // Verifies: FR-XXX patterns. Resolves aliases to canonical IDs."""
    source_dirs = ["Source"]
    verified_frs: dict[str, list[str]] = {}  # canonical_id -> [file_paths]
    raw_ids_found = set()

    pattern = re.compile(r"Verifies:\s*((?:FR-[A-Z0-9-]+(?:\s*,\s*)?)+)")

    for s_dir in source_dirs:
        path = Path(s_dir)
        if not path.exists():
            continue

        for root, _, files in os.walk(path):
            for file in files:
                if file.endswith((".ts", ".tsx", ".go", ".js", ".jsx", ".py", ".sh")):
                    f_path = Path(root) / file
                    try:
                        content = f_path.read_text(encoding="utf-8")
                        matches = pattern.findall(content)
                        for m in matches:
                            parts = [p.strip() for p in m.split(",")]
                            for part in parts:
                                part = part.strip()
                                if not part or not part.startswith("FR-"):
                                    continue
                                raw_ids_found.add(part)
                                # Resolve alias to canonical ID
                                canonical = aliases.get(part, part)
                                if canonical not in verified_frs:
                                    verified_frs[canonical] = []
                                verified_frs[canonical].append(str(f_path))
                    except OSError:
                        continue

    return verified_frs, raw_ids_found


def generate_report(in_specs: set, verified: dict, raw_ids: set, aliases: dict):
    """Produces a gap analysis report with alias resolution."""
    covered = set(verified.keys()) & in_specs
    missing = sorted(list(in_specs - covered))
    untracked = sorted(list(set(verified.keys()) - in_specs))

    # Count how many raw IDs were resolved via aliases
    alias_resolved = sum(1 for rid in raw_ids if rid in aliases)
    unresolved_legacy = sorted([rid for rid in raw_ids if rid not in aliases and rid not in in_specs])

    coverage_pct = (len(covered) / len(in_specs) * 100) if in_specs else 0

    report = {
        "summary": {
            "canonical_frs_in_specs": len(in_specs),
            "canonical_frs_covered": len(covered),
            "coverage_percentage": f"{coverage_pct:.1f}%",
            "raw_verifies_ids_in_source": len(raw_ids),
            "alias_resolved_count": alias_resolved,
            "unresolved_legacy_ids": len(unresolved_legacy),
        },
        "covered_frs": sorted(list(covered)),
        "missing_frs": missing,
        "untracked_implementations": untracked,
        "unresolved_legacy_ids": unresolved_legacy,
        "coverage_by_file": {
            fr_id: files for fr_id, files in sorted(verified.items()) if fr_id in in_specs
        },
    }

    return report


def main():
    print("--- Level 5 Spec-Drift Audit ---")

    # Load alias map
    alias_path = ALIAS_FILE
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--aliases" and i + 2 < len(sys.argv):
            alias_path = sys.argv[i + 2]
    aliases = load_aliases(alias_path)
    if aliases:
        print(f"Loaded {len(aliases)} FR ID aliases from {alias_path}")

    # Extract
    in_specs = extract_frs_from_specs()
    verified, raw_ids = extract_verified_frs(aliases)
    report = generate_report(in_specs, verified, raw_ids, aliases)

    # Console output
    s = report["summary"]
    print(f"\nCanonical FRs in specs:  {s['canonical_frs_in_specs']}")
    print(f"Canonical FRs covered:  {s['canonical_frs_covered']}")
    print(f"Coverage:               {s['coverage_percentage']}")
    print(f"Raw // Verifies IDs:    {s['raw_verifies_ids_in_source']}")
    print(f"Alias-resolved:         {s['alias_resolved_count']}")
    print(f"Unresolved legacy IDs:  {s['unresolved_legacy_ids']}")

    if report["missing_frs"]:
        print(f"\nTOP GAPS (of {len(report['missing_frs'])} missing):")
        for gap in report["missing_frs"][:15]:
            print(f"  [MISSING] {gap}")

    if report["unresolved_legacy_ids"]:
        print(f"\nUNRESOLVED LEGACY IDs (of {len(report['unresolved_legacy_ids'])}):")
        for lid in report["unresolved_legacy_ids"][:10]:
            print(f"  [LEGACY] {lid} — add to {ALIAS_FILE} to map to canonical ID")

    # Save JSON report
    with open("spec-drift-report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print(f"\nFull audit saved to spec-drift-report.json")

    # Exit code: 1 if any P1-grade safety FRs are missing
    safety_frs = {"FR-EM-004", "FR-EM-008", "FR-EM-009", "FR-DR-016", "FR-AC-003"}
    missing_safety = safety_frs & set(report["missing_frs"])
    if missing_safety:
        print(f"\n⚠ SAFETY-CRITICAL FRs MISSING: {', '.join(sorted(missing_safety))}")
        sys.exit(1)


if __name__ == "__main__":
    main()
