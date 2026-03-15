from __future__ import annotations

import argparse
import os
import stat
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

DIRECTORIES_TO_REMOVE = [
    "dist",
    "node_modules",
    ".hajimi",
    ".test-build",
    "coverage",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tmp-smoke",
    ".tmp-api-tests",
    ".tmp",
    ".cache",
    ".turbo",
    ".parcel-cache",
    ".next",
]

FILE_PATTERNS_TO_REMOVE = [
    "*.log",
    "*.tsbuildinfo",
    "NEXT_SESSION_PLAN.md",
]

DIRECTORY_PATTERNS_TO_REMOVE = [
    ".tmp-smoke-check-*",
    ".test-tmp-*",
    "api-*",
    "__pycache__",
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean local runtime state, build artifacts, demo folders, logs, and reset the local .env file by default.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only show what would be removed or reset.",
    )
    parser.add_argument(
        "--keep-env",
        action="store_true",
        help="Do not reset the local .env file.",
    )
    args = parser.parse_args()

    removed_paths: list[Path] = []
    reset_files: list[Path] = []

    for relative_dir in DIRECTORIES_TO_REMOVE:
        target = ROOT / relative_dir
        if target.exists():
            remove_path(target, args.dry_run)
            removed_paths.append(target)

    for pattern in DIRECTORY_PATTERNS_TO_REMOVE:
        for target in iter_matches(pattern):
            if not target.is_dir():
                continue
            remove_path(target, args.dry_run)
            removed_paths.append(target)

    for pattern in FILE_PATTERNS_TO_REMOVE:
        for target in iter_matches(pattern):
            if target.is_file():
                remove_path(target, args.dry_run)
                removed_paths.append(target)

    if not args.keep_env:
        hajimi_dir = ROOT / ".hajimi"
        hajimi_dir.mkdir(parents=True, exist_ok=True)
        env_file = hajimi_dir / ".env"
        write_text(env_file, build_env_template(), args.dry_run)
        reset_files.append(env_file)

    print_summary(removed_paths, reset_files, args.dry_run)


def iter_matches(pattern: str) -> list[Path]:
    matches = []
    for candidate in ROOT.rglob(pattern):
        if candidate == ROOT:
            continue
        if candidate.is_dir() or candidate.is_file():
            matches.append(candidate)

    unique_matches: list[Path] = []
    seen: set[Path] = set()
    for item in sorted(matches):
        if item in seen:
            continue
        seen.add(item)
        unique_matches.append(item)
    return unique_matches


def remove_path(target: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] remove {target.relative_to(ROOT)}")
        return

    if target.is_dir():
        shutil.rmtree(target, ignore_errors=False, onerror=handle_remove_readonly)
    else:
        target.unlink(missing_ok=True)

    print(f"[removed] {target.relative_to(ROOT)}")


def write_text(target: Path, content: str, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] reset {target.relative_to(ROOT)}")
        return

    target.write_text(content, encoding="utf-8")
    print(f"[reset] {target.relative_to(ROOT)}")


def print_summary(removed_paths: list[Path], reset_files: list[Path], dry_run: bool) -> None:
    action = "Would clean" if dry_run else "Cleaned"
    print("")
    print(f"{action} {len(removed_paths)} path(s).")
    print(f"{action} {len(reset_files)} reset file(s).")
    print("")
    print("Done.")


def handle_remove_readonly(func, path, exc_info) -> None:
    _ = exc_info
    os.chmod(path, stat.S_IWRITE)
    func(path)


def build_env_template() -> str:
    # Keep this template aligned with src/config/init.ts so `hajimi init`
    # and local reset produce the same project-scoped .hajimi/.env defaults.
    return "\n".join(
        [
            "# Hajimi CLI env template",
            "# Keep only one active provider/model block below.",
            "# The variable names are HAJIMI_* for compatibility, but baseUrl/model can point to other OpenAI-compatible providers.",
            "",
            "# Active default: SiliconFlow + DeepSeek V3.2",
            "HAJIMI_API_KEY=replace-with-your-key",
            "HAJIMI_BASE_URL=https://api.siliconflow.cn/v1",
            "HAJIMI_MODEL=deepseek-ai/DeepSeek-V3.2",
            "",
            "# Backup example: DeepSeek official",
            "# HAJIMI_API_KEY=replace-with-your-key",
            "# HAJIMI_BASE_URL=https://api.deepseek.com",
            "# HAJIMI_MODEL=deepseek-reasoner",
            "",
            "# Backup example: SiliconFlow + MiniMax M2.5",
            "# HAJIMI_API_KEY=replace-with-your-key",
            "# HAJIMI_BASE_URL=https://api.siliconflow.cn/v1",
            "# HAJIMI_MODEL=Pro/MiniMaxAI/MiniMax-M2.5",
            "",
            "# Backup example: SiliconFlow + Kimi K2.5",
            "# HAJIMI_API_KEY=replace-with-your-key",
            "# HAJIMI_BASE_URL=https://api.siliconflow.cn/v1",
            "# HAJIMI_MODEL=Pro/moonshotai/Kimi-K2.5",
            "",
            "# Remote mode defaults for hajimi remote",
            "HAJIMI_REMOTE_ENABLED=true",
            "HAJIMI_REMOTE_BIND=lan",
            "HAJIMI_REMOTE_PORT=4387",
            "# Leave blank to auto-detect a LAN address at startup.",
            "# HAJIMI_REMOTE_HOST=",
            "# HAJIMI_REMOTE_TOKEN=replace-with-a-shared-token",
            "# HAJIMI_REMOTE_PUBLIC_URL=",
            "",
        ]
    )


if __name__ == "__main__":
    main()
