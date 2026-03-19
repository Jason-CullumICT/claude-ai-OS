#!/usr/bin/env python3
"""Traceability Enforcer -- verifies every FR-XXX in a plan has a '// Verifies: FR-XXX' comment in Source/.

Usage:
  python3 tools/traceability-enforcer.py                    # auto-detect most recent plan
  python3 tools/traceability-enforcer.py --plan my-plan     # target specific plan
  python3 tools/traceability-enforcer.py --file Plans/my-plan/requirements.md  # target specific file
"""
import argparse
import os
import re
import sys
from pathlib import Path


def get_active_requirements(plan_name=None, file_path=None):
    """Finds the requirements.md file to enforce.

    Priority: --file > --plan > most-recently-modified fallback.
    """
    if file_path:
        p = Path(file_path)
        if not p.exists():
            print(f"Error: Specified file not found: {file_path}")
            sys.exit(1)
        return p

    plans_dir = Path("Plans")
    if not plans_dir.exists():
        print("Error: Plans/ directory not found.")
        sys.exit(1)

    if plan_name:
        # Look for requirements.md in the named plan directory
        candidates = list(plans_dir.glob(f"{plan_name}/**/requirements.md"))
        if not candidates:
            # Try case-insensitive and partial match
            candidates = [
                f for f in plans_dir.glob("**/requirements.md")
                if plan_name.lower() in str(f.parent).lower()
            ]
        if not candidates:
            print(f"Error: No requirements.md found for plan '{plan_name}'.")
            print(f"Available plans: {', '.join(d.name for d in plans_dir.iterdir() if d.is_dir())}")
            sys.exit(1)
        return candidates[0]

    # Fallback: most recently modified requirements.md
    req_files = list(plans_dir.glob("**/requirements.md"))
    if not req_files:
        # Fallback to any .md in Plans/ that looks like requirements
        req_files = [f for f in plans_dir.glob("*.md") if "requirements" in f.name.lower()]

    if not req_files:
        return None

    return max(req_files, key=os.path.getmtime)


def extract_fr_ids(req_file):
    """Extracts FR-XXX IDs from the requirements file."""
    content = req_file.read_text(encoding="utf-8")
    # Matches patterns like FR-A001, FR-001, FR-ID-001
    pattern = re.compile(r"FR-[A-Z0-9-]+")
    return sorted(list(set(pattern.findall(content))))


def check_traceability(fr_ids):
    """Checks for '// Verifies: FR-XXX' in Source/ and E2E/ directories."""
    source_dirs = ["Source", "E2E"]

    # Pre-compile patterns for speed
    patterns = {fr: re.compile(fr) for fr in fr_ids}
    found_frs = {fr: False for fr in fr_ids}

    print(f"Scanning {len(fr_ids)} requirements across {source_dirs}...")

    for s_dir in source_dirs:
        path = Path(s_dir)
        if not path.exists():
            continue

        for root, _, files in os.walk(path):
            for file in files:
                if file.endswith((".ts", ".tsx", ".go", ".js", ".jsx", ".py", ".sh")):
                    f_path = Path(root) / file
                    try:
                        f_content = f_path.read_text(encoding="utf-8")
                        # Look for 'Verifies: FR-XXX'
                        if "Verifies:" in f_content:
                            for fr, pattern in patterns.items():
                                if not found_frs[fr] and pattern.search(f_content):
                                    found_frs[fr] = True
                    except Exception:
                        # Skip files that can't be read (binary, encoding issues)
                        continue

    missing = [fr for fr, found in found_frs.items() if not found]
    return missing


def main():
    parser = argparse.ArgumentParser(
        description="Verify every FR-XXX in a plan has a '// Verifies: FR-XXX' comment in Source/."
    )
    parser.add_argument(
        "--plan", type=str, default=None,
        help="Name of the plan directory under Plans/ (e.g., 'my-feature')"
    )
    parser.add_argument(
        "--file", type=str, default=None,
        help="Direct path to a requirements.md file"
    )
    args = parser.parse_args()

    req_file = get_active_requirements(plan_name=args.plan, file_path=args.file)
    if not req_file:
        print("No active requirements file found to enforce.")
        sys.exit(0)

    print(f"Targeting requirements from: {req_file}")
    fr_ids = extract_fr_ids(req_file)

    if not fr_ids:
        print("No FR IDs found in requirements file.")
        sys.exit(0)

    missing = check_traceability(fr_ids)

    if missing:
        print("\n" + "!" * 60)
        print(f"TRACEABILITY FAILURE: {len(missing)} requirements lack implementation!")
        print("!" * 60)
        for fr in missing:
            print(f"  [MISSING] {fr}")
        print("\nEnsure your code contains '// Verifies: FR-XXX' comments.")
        sys.exit(1)
    else:
        print("\n" + "*" * 60)
        print("TRACEABILITY PASSED: All requirements have implementation references.")
        print("*" * 60)
        sys.exit(0)


if __name__ == "__main__":
    main()
