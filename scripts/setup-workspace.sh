#!/bin/bash
# Setup git worktrees for each pet.
# Each pet gets its own worktree on a dedicated branch,
# sharing the same .git but with isolated working directories.
#
# Usage:
#   ./scripts/setup-workspace.sh <repo-path> <workspace-dir> [pet-ids...]
#
# Example:
#   ./scripts/setup-workspace.sh ~/git/my-project ~/workspace coboonge reboong

set -euo pipefail

REPO_PATH="${1:?Usage: $0 <repo-path> <workspace-dir> [pet-ids...]}"
WORKSPACE_DIR="${2:?Usage: $0 <repo-path> <workspace-dir> [pet-ids...]}"
shift 2
PET_IDS=("${@:-coboonge reboong}")

if [ ${#PET_IDS[@]} -eq 0 ]; then
  PET_IDS=(coboonge reboong)
fi

echo "Setting up workspace for pets: ${PET_IDS[*]}"
echo "Repository: $REPO_PATH"
echo "Workspace:  $WORKSPACE_DIR"
echo ""

cd "$REPO_PATH"

# Ensure we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: $REPO_PATH is not a git repository"
  exit 1
fi

MAIN_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")
echo "Main branch: $MAIN_BRANCH"

mkdir -p "$WORKSPACE_DIR"

for PET_ID in "${PET_IDS[@]}"; do
  BRANCH="pet/$PET_ID"
  WORKTREE_PATH="$WORKSPACE_DIR/$PET_ID"

  echo ""
  echo "--- Setting up $PET_ID ---"

  # Create branch if it doesn't exist
  if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "Creating branch: $BRANCH"
    git branch "$BRANCH" "$MAIN_BRANCH"
  else
    echo "Branch already exists: $BRANCH"
  fi

  # Create worktree if it doesn't exist
  if [ -d "$WORKTREE_PATH" ]; then
    echo "Worktree already exists: $WORKTREE_PATH"
  else
    echo "Creating worktree: $WORKTREE_PATH on $BRANCH"
    git worktree add "$WORKTREE_PATH" "$BRANCH"
  fi

  echo "Done: $PET_ID -> $WORKTREE_PATH ($BRANCH)"
done

echo ""
echo "=== Setup complete ==="
echo ""
echo "Update docker-compose.yml or daemon.yaml with workspace paths:"
for PET_ID in "${PET_IDS[@]}"; do
  echo "  $PET_ID: $WORKSPACE_DIR/$PET_ID"
done
echo ""
echo "Or set WORKSPACE_PATH in .env.docker:"
echo "  WORKSPACE_PATH=$WORKSPACE_DIR"
