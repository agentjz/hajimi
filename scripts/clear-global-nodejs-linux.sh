#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

DRY_RUN=0
ASSUME_YES=0
ROOTS=()
INCLUDE_HIDDEN=0

usage() {
  cat <<'EOF'
Linux Node.js Global Cleanup (keep Node, purge npm packages/caches + node_modules)

Usage:
  ./scripts/clear-global-nodejs-linux.sh [--dry-run] [--yes] [--root <dir>]... [--include-hidden]

Options:
  --dry-run         Print what would be deleted, but do not delete anything.
  --yes             Do not ask for confirmation.
  --root <dir>      Root directory to search for node_modules (can be provided multiple times).
                    Default: $HOME
  --include-hidden  Also search hidden directories under the roots (more aggressive).

What this does:
  - Removes Hajimi global state directories under XDG (Linux):
    ~/.config/hajimi, ~/.local/share/hajimi, ~/.cache/hajimi (respecting XDG_* overrides)
  - Uninstalls all global npm packages except npm/corepack
  - Cleans npm caches (~/.npm, ~/.cache/npm, node-gyp/corepack caches)
  - Deletes node_modules directories under the chosen roots, while avoiding your Node installation prefix

Important:
  - This script is destructive. Start with --dry-run.
  - It will NOT delete Node itself, but it WILL delete installed dependencies (node_modules).
EOF
}

log() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "[warn] $*" >&2; }

remove_dir() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    log "[skip] dir  \"$target\""
    return 0
  fi

  if (( DRY_RUN )); then
    log "[dry-run] dir  \"$target\""
    return 0
  fi

  rm -rf -- "$target"
  if [[ -e "$target" ]]; then
    warn "dir  \"$target\" was not fully removed"
  else
    log "[removed] dir  \"$target\""
  fi
}

remove_file() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    log "[skip] file \"$target\""
    return 0
  fi

  if (( DRY_RUN )); then
    log "[dry-run] file \"$target\""
    return 0
  fi

  rm -f -- "$target"
  if [[ -e "$target" ]]; then
    warn "file \"$target\" was not fully removed"
  else
    log "[removed] file \"$target\""
  fi
}

detect_os() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    warn "This script is intended for Linux only."
    exit 1
  fi

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    log "Detected distro: ${PRETTY_NAME:-${NAME:-unknown}}"
  else
    log "Detected distro: unknown (missing /etc/os-release)"
  fi
}

get_node_prefix() {
  if ! command -v node >/dev/null 2>&1; then
    echo ""
    return 0
  fi

  node -p "require('path').dirname(require('path').dirname(process.execPath))" 2>/dev/null || true
}

get_npm_global_root() {
  if ! command -v npm >/dev/null 2>&1; then
    echo ""
    return 0
  fi

  npm root -g 2>/dev/null || true
}

get_global_packages_to_remove() {
  if ! command -v npm >/dev/null 2>&1; then
    return 0
  fi

  local json
  json="$(npm ls -g --depth=0 --json 2>/dev/null || true)"
  if [[ -z "$json" ]]; then
    return 0
  fi

  node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    let parsed = {};
    try { parsed = JSON.parse(input); } catch { process.exit(0); }
    const deps = parsed && parsed.dependencies && typeof parsed.dependencies === "object" ? parsed.dependencies : {};
    const keep = new Set(["npm", "corepack"]);
    const names = Object.keys(deps).filter((name) => !keep.has(name)).sort();
    process.stdout.write(names.join("\n"));
  ' <<<"$json" 2>/dev/null || true
}

uninstall_global_packages() {
  if ! command -v npm >/dev/null 2>&1; then
    warn "npm was not found; skipping global npm package removal."
    return 0
  fi

  local pkgs=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && pkgs+=("$line")
  done < <(get_global_packages_to_remove)

  if (( ${#pkgs[@]} == 0 )); then
    log "[skip] no global npm packages to uninstall (except npm/corepack)."
    return 0
  fi

  log "Global npm packages to uninstall (except npm/corepack):"
  for pkg in "${pkgs[@]}"; do
    log "  - $pkg"
  done

  for pkg in "${pkgs[@]}"; do
    if (( DRY_RUN )); then
      log "[dry-run] npm uninstall -g \"$pkg\""
      continue
    fi

    # Do not fail the entire cleanup if one package refuses to uninstall.
    npm uninstall -g "$pkg" >/dev/null 2>&1 || warn "npm uninstall -g \"$pkg\" failed (continuing)"
  done

  # Best-effort: remove now-empty scope directories under the global root.
  local root
  root="$(get_npm_global_root)"
  if [[ -n "$root" && -d "$root" ]]; then
    find "$root" -maxdepth 1 -type d -name "@*" -empty -print0 2>/dev/null | while IFS= read -r -d '' dir; do
      remove_dir "$dir"
    done
  fi
}

clean_npm_caches() {
  log ""
  log "Clearing npm caches..."

  if command -v npm >/dev/null 2>&1; then
    if (( DRY_RUN )); then
      log "[dry-run] npm cache clean --force"
    else
      npm cache clean --force >/dev/null 2>&1 || warn "npm cache clean failed (continuing)"
    fi
  fi

  local xdg_cache xdg_data
  xdg_cache="${XDG_CACHE_HOME:-$HOME/.cache}"
  xdg_data="${XDG_DATA_HOME:-$HOME/.local/share}"

  remove_dir "$HOME/.npm"
  remove_dir "$xdg_cache/npm"
  remove_dir "$HOME/.node-gyp"
  remove_dir "$xdg_cache/node-gyp"
  remove_dir "$xdg_cache/corepack"
  remove_dir "$xdg_data/corepack"
}

clear_hajimi_state() {
  log ""
  log "Clearing Hajimi global state..."
  local xdg_config xdg_data xdg_cache
  xdg_config="${XDG_CONFIG_HOME:-$HOME/.config}"
  xdg_data="${XDG_DATA_HOME:-$HOME/.local/share}"
  xdg_cache="${XDG_CACHE_HOME:-$HOME/.cache}"

  remove_dir "$xdg_config/hajimi"
  remove_dir "$xdg_data/hajimi"
  remove_dir "$xdg_cache/hajimi"
}

purge_node_modules() {
  log ""
  log "Deleting node_modules directories under roots:"
  for root in "${ROOTS[@]}"; do
    log "  - $root"
  done

  local node_prefix
  node_prefix="$(get_node_prefix)"
  if [[ -n "$node_prefix" ]]; then
    log ""
    log "Node install prefix detected (will be excluded from node_modules purge):"
    log "  $node_prefix"
  else
    warn "Node was not detected; node_modules purge will not exclude a node prefix automatically."
  fi

  local exclude=()
  if (( ! INCLUDE_HIDDEN )); then
    exclude+=(".git" ".nvm" ".asdf" ".cache" ".config" ".local" ".npm")
  fi

  for root in "${ROOTS[@]}"; do
    if [[ -z "$root" || ! -d "$root" ]]; then
      warn "root does not exist or is not a directory: $root"
      continue
    fi

    # Build a prune expression for find.
    # We prune:
    # - Node prefix (if it is inside the root)
    # - A set of hidden/system directories (unless --include-hidden)
    local find_args=()
    find_args+=("$root")
    find_args+=("(")
    if [[ -n "$node_prefix" && "$node_prefix" == "$root"* ]]; then
      find_args+=("-path" "$node_prefix" "-o" "-path" "$node_prefix/*" "-o")
    fi

    for name in "${exclude[@]}"; do
      find_args+=("-path" "$root/$name" "-o" "-path" "$root/$name/*" "-o")
    done

    # Trim the final "-o" if present by appending a false path.
    find_args+=("-path" "__never__")
    find_args+=(")")
    find_args+=("-prune" "-o" "-type" "d" "-name" "node_modules" "-print0")

    local count=0
    while IFS= read -r -d '' dir; do
      count=$((count + 1))
      remove_dir "$dir"
    done < <(find "${find_args[@]}" 2>/dev/null || true)

    log "[info] removed node_modules: $count under $root"
  done
}

main() {
  while [[ $# -gt 0 ]]; do
    case "${1:-}" in
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --yes)
        ASSUME_YES=1
        shift
        ;;
      --root)
        if [[ -z "${2:-}" ]]; then
          warn "--root requires a directory"
          exit 2
        fi
        ROOTS+=("$2")
        shift 2
        ;;
      --include-hidden)
        INCLUDE_HIDDEN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        warn "Unknown argument: $1"
        usage
        exit 2
        ;;
    esac
  done

  if (( ${#ROOTS[@]} == 0 )); then
    ROOTS+=("${HOME}")
  fi

  log ""
  log "Node.js Global Cleanup (Linux)"
  log "=============================="
  log ""
  detect_os
  log ""

  if command -v node >/dev/null 2>&1; then
    log "Node: $(command -v node) ($(node -v 2>/dev/null || true))"
  else
    warn "Node is not available in PATH."
  fi

  if command -v npm >/dev/null 2>&1; then
    log "npm : $(command -v npm) ($(npm -v 2>/dev/null || true))"
    log "npm prefix -g: $(npm prefix -g 2>/dev/null || true)"
    log "npm root   -g: $(npm root -g 2>/dev/null || true)"
  else
    warn "npm is not available in PATH."
  fi

  log ""
  log "This will purge:"
  log "  - Global npm packages (except npm/corepack)"
  log "  - npm caches and related caches"
  log "  - Hajimi global state (XDG dirs)"
  log "  - node_modules directories under the selected roots"
  log ""

  if (( ! ASSUME_YES )); then
    read -r -p "Proceed? [y/N] " answer
    case "${answer:-}" in
      y|Y|yes|YES)
        ;;
      *)
        log "Aborted."
        exit 0
        ;;
    esac
  fi

  clear_hajimi_state
  uninstall_global_packages
  clean_npm_caches
  purge_node_modules

  log ""
  if (( DRY_RUN )); then
    log "[dry-run] No files were deleted."
  else
    log "[done] Cleanup completed."
    log "Notes:"
    log "  - Node itself was not removed."
    log "  - Global npm packages were removed (except npm/corepack)."
    log "  - Project dependencies (node_modules) were deleted under the selected roots."
  fi
  log ""
}

main "$@"

