#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/publish.sh [options]

Options:
  --tag <tag>        npm dist-tag to publish with (default: latest)
  --dry-run          Run npm publish in dry-run mode
  --allow-dirty      Allow publishing with uncommitted git changes
  --skip-checks      Skip lint/build checks
  --otp <code>       npm 2FA one-time password
  -h, --help         Show this help
EOF
}

TAG="latest"
DRY_RUN=false
ALLOW_DIRTY=false
SKIP_CHECKS=false
OTP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      shift
      if [[ $# -eq 0 || -z "${1:-}" ]]; then
        echo "Missing value for --tag" >&2
        usage
        exit 1
      fi
      TAG="$1"
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      ;;
    --skip-checks)
      SKIP_CHECKS=true
      ;;
    --otp)
      shift
      if [[ $# -eq 0 || -z "${1:-}" ]]; then
        echo "Missing value for --otp" >&2
        usage
        exit 1
      fi
      OTP="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but was not found in PATH." >&2
  exit 1
fi

if ! ${ALLOW_DIRTY}; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree is not clean. Commit/stash changes or use --allow-dirty." >&2
    exit 1
  fi
fi

if ! npm whoami >/dev/null 2>&1; then
  echo "Not logged in to npm. Run 'npm login' first." >&2
  exit 1
fi

if ! ${SKIP_CHECKS}; then
  echo "Running pre-publish checks (lint + build)..."
  npm run lint
  npm run build
fi

echo "Previewing package contents..."
npm pack --dry-run >/dev/null

PUBLISH_CMD=(npm publish --access public --tag "${TAG}")
if ${DRY_RUN}; then
  PUBLISH_CMD+=(--dry-run)
fi
if [[ -n "${OTP}" ]]; then
  PUBLISH_CMD+=(--otp "${OTP}")
fi

echo "Publishing with command: ${PUBLISH_CMD[*]}"
"${PUBLISH_CMD[@]}"

if ${DRY_RUN}; then
  echo "Dry-run publish completed."
else
  echo "Publish completed successfully."
fi
