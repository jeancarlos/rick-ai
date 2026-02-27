#!/bin/sh
#
# Safe deploy pipeline for Rick (rick-ai).
# Called by edit-session.ts after Claude Code edits source code,
# and by the OTA update/import detached containers in health.ts.
#
# Runs inside a docker:cli container (Alpine) with docker.sock mounted.
#
# Flow:
#   1. Backup current project files (src/, scripts/, docker/, Dockerfile, etc.)
#   2. Copy all edited files from staging area to project dir
#   3. Build candidate image (includes tsc — if tsc fails, build fails)
#   4. Start candidate container in HEALTH_ONLY mode (no WhatsApp conflict)
#   5. Health check candidate via wget
#   6. If healthy: swap (stop current, promote candidate via docker compose)
#   7. Watchdog: monitor for 60s after swap
#   8. If unhealthy at any point: rollback
#
# Usage: deploy.sh <staging_dir>
#   staging_dir: directory containing the edited src/ files (and optionally
#                scripts/, docker/, Dockerfile, package.json, etc.)
#
# Exit codes:
#   0 = success
#   1 = build failed (includes tsc errors)
#   2 = smoke test failed
#   3 = watchdog failed (rollback performed)
#   4 = rollback failed (CRITICAL)

set -eu

# PROJECT_DIR can be passed as env var from edit-session.ts, fallback to $HOME/rick-ai
PROJECT_DIR="${PROJECT_DIR:-$HOME/rick-ai}"
STAGING_DIR="${1:-}"
BACKUP_DIR="$PROJECT_DIR/.deploy-backup"
CANDIDATE_TAG="rick-ai-agent:candidate"
CANDIDATE_NAME="rick-ai-candidate"
HEALTH_PORT_CANDIDATE=8081
HEALTH_PORT_MAIN=80
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

log() { echo "[deploy] $(date '+%H:%M:%S') $*"; }
err() { echo "[deploy] ERROR: $*" >&2; }

# ==================== VALIDATION ====================

if [ -z "$STAGING_DIR" ]; then
  err "Usage: deploy.sh <staging_dir>"
  exit 1
fi

if [ ! -d "$STAGING_DIR/src" ]; then
  err "No src/ directory found in staging dir: $STAGING_DIR"
  exit 1
fi

# ==================== HELPERS ====================

do_rollback() {
  log "Restoring from backup..."
  # Restore directories
  for d in src scripts docker .github; do
    if [ -d "$BACKUP_DIR/$d" ]; then
      rm -rf "$PROJECT_DIR/$d"
      cp -r "$BACKUP_DIR/$d" "$PROJECT_DIR/$d"
    fi
  done
  # Restore root files
  for f in Dockerfile docker-compose.yml package.json tsconfig.json package-lock.json \
            .gitignore .env.example LICENSE .rick-version deploy-db.sh setup-oracle.sh; do
    if [ -f "$BACKUP_DIR/$f" ]; then
      cp "$BACKUP_DIR/$f" "$PROJECT_DIR/$f"
    fi
  done
  for f in "$BACKUP_DIR"/*.md; do
    [ -f "$f" ] && cp "$f" "$PROJECT_DIR/" || true
  done
  rm -rf "$BACKUP_DIR"
}

# ==================== STEP 1: BACKUP ====================

log "Step 1: Backing up project files"
rm -rf "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
# Backup directories
for d in src scripts docker .github; do
  if [ -d "$PROJECT_DIR/$d" ]; then
    cp -r "$PROJECT_DIR/$d" "$BACKUP_DIR/$d"
  fi
done
# Backup root-level files
for f in Dockerfile docker-compose.yml package.json tsconfig.json package-lock.json \
          .gitignore .env.example LICENSE .rick-version deploy-db.sh setup-oracle.sh; do
  if [ -f "$PROJECT_DIR/$f" ]; then
    cp "$PROJECT_DIR/$f" "$BACKUP_DIR/$f"
  fi
done
for f in "$PROJECT_DIR"/*.md; do
  [ -f "$f" ] && cp "$f" "$BACKUP_DIR/" || true
done
log "Backup created at $BACKUP_DIR"

# ==================== STEP 2: COPY STAGED FILES ====================

log "Step 2: Copying staged files to project dir"

# Clear and replace directories to avoid stale files from deleted sources.
# Using rm -rf + cp -r instead of cp -r src/* prevents deleted files from
# persisting across deploys.
rm -rf "$PROJECT_DIR/src" && cp -r "$STAGING_DIR/src" "$PROJECT_DIR/src"

if [ -d "$STAGING_DIR/scripts" ]; then
  rm -rf "$PROJECT_DIR/scripts" && cp -r "$STAGING_DIR/scripts" "$PROJECT_DIR/scripts"
fi
if [ -d "$STAGING_DIR/docker" ]; then
  rm -rf "$PROJECT_DIR/docker" && cp -r "$STAGING_DIR/docker" "$PROJECT_DIR/docker"
fi
if [ -d "$STAGING_DIR/.github" ]; then
  rm -rf "$PROJECT_DIR/.github" && cp -r "$STAGING_DIR/.github" "$PROJECT_DIR/.github"
fi

# Copy root-level config files that may have been edited in the staging dir
for f in Dockerfile docker-compose.yml package.json tsconfig.json package-lock.json \
          .gitignore .env.example LICENSE .rick-version deploy-db.sh setup-oracle.sh; do
  if [ -f "$STAGING_DIR/$f" ]; then
    cp "$STAGING_DIR/$f" "$PROJECT_DIR/$f"
  fi
done
# Copy markdown files (README.md, AGENTS.md, etc.)
for f in "$STAGING_DIR"/*.md; do
  [ -f "$f" ] && cp "$f" "$PROJECT_DIR/" || true
done

log "Staged files applied"

# ==================== STEP 3: BUILD CANDIDATE ====================

# tsc runs as part of `npm run build` inside the Dockerfile.
# If TypeScript has errors, the Docker build fails here.
#
# Version priority:
#   1. STAGING_DIR/.rick-version — set by OTA update (has the real new SHA)
#   2. git — for edit-session deploys where staging doesn't have .rick-version
#   3. PROJECT_DIR/.rick-version — last resort
#
# Mark directory as safe — deploy runs as root inside docker:cli but files
# belong to ubuntu, causing git "dubious ownership" errors.
if [ -f "$STAGING_DIR/.rick-version" ]; then
  COMMIT_SHA=$(head -1 "$STAGING_DIR/.rick-version" 2>/dev/null || echo "unknown")
  COMMIT_DATE=$(tail -1 "$STAGING_DIR/.rick-version" 2>/dev/null || echo "unknown")
elif command -v git >/dev/null 2>&1 && [ -d "$PROJECT_DIR/.git" ]; then
  git config --global --add safe.directory "$PROJECT_DIR" 2>/dev/null || true
  COMMIT_SHA=$(cd "$PROJECT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  COMMIT_DATE=$(cd "$PROJECT_DIR" && git log -1 --format='%cI' 2>/dev/null || echo "unknown")
elif [ -f "$PROJECT_DIR/.rick-version" ]; then
  COMMIT_SHA=$(head -1 "$PROJECT_DIR/.rick-version" 2>/dev/null || echo "unknown")
  COMMIT_DATE=$(tail -1 "$PROJECT_DIR/.rick-version" 2>/dev/null || echo "unknown")
else
  COMMIT_SHA="unknown"
  COMMIT_DATE="unknown"
fi
log "Version: $COMMIT_SHA ($COMMIT_DATE)"

# Persist version to .rick-version so the Dockerfile can pick it up
# even when --build-arg is not provided (e.g. docker compose up --build)
printf '%s\n%s\n' "$COMMIT_SHA" "$COMMIT_DATE" > "$PROJECT_DIR/.rick-version"

log "Step 3: Building candidate image (includes tsc check)..."
if ! docker build --build-arg "COMMIT_SHA=$COMMIT_SHA" --build-arg "COMMIT_DATE=$COMMIT_DATE" -t "$CANDIDATE_TAG" -f "$PROJECT_DIR/Dockerfile" "$PROJECT_DIR" 2>&1; then
  err "Docker build failed (likely tsc errors)! Rolling back..."
  do_rollback
  exit 1
fi
log "Candidate image built: $CANDIDATE_TAG"

# ==================== STEP 4: SMOKE TEST CANDIDATE ====================

log "Step 4: Starting candidate container for smoke test (HEALTH_ONLY mode)..."

# Stop any leftover candidate container
docker rm -f "$CANDIDATE_NAME" 2>/dev/null || true

# Start candidate in HEALTH_ONLY mode: only health server + DB check, no WhatsApp.
# This avoids conflicting with the running main container's WhatsApp session.
docker run -d \
  --name "$CANDIDATE_NAME" \
  --env-file "$PROJECT_DIR/.env" \
  -e HEALTH_ONLY=true \
  -p "$HEALTH_PORT_CANDIDATE:80" \
  "$CANDIDATE_TAG"

log "Candidate container started in HEALTH_ONLY mode, waiting for health..."

# ==================== STEP 5: HEALTH CHECK CANDIDATE ====================

HEALTHY=false
i=1
while [ "$i" -le 20 ]; do
  sleep 3
  RESP=$(wget -qO- "http://localhost:$HEALTH_PORT_CANDIDATE/health" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    HEALTHY=true
    log "Candidate is healthy after ${i}x3s"
    break
  fi
  log "Health check attempt $i/20: $RESP"
  i=$((i + 1))
done

# Stop candidate container (it was just for testing)
docker rm -f "$CANDIDATE_NAME" 2>/dev/null || true

if [ "$HEALTHY" != "true" ]; then
  err "Candidate failed health check! Rolling back..."
  do_rollback
  # Clean up candidate image
  docker rmi "$CANDIDATE_TAG" 2>/dev/null || true
  exit 2
fi

log "Smoke test passed!"

# ==================== STEP 6: SWAP ====================

log "Step 6: Swapping — promoting candidate image..."

# Re-tag the candidate image as the image docker-compose expects.
# This avoids rebuilding the image a second time — the candidate was already
# built and smoke-tested in steps 3-5.
COMPOSE_IMAGE="rick-ai-agent:latest"
docker tag "$CANDIDATE_TAG" "$COMPOSE_IMAGE"

# Restart the service using the pre-built image (no --build needed)
cd "$PROJECT_DIR"
docker compose -f "$COMPOSE_FILE" up -d 2>&1

log "Main service restarted with new code"

# Clean up candidate tag (the image is still referenced as $COMPOSE_IMAGE)
docker rmi "$CANDIDATE_TAG" 2>/dev/null || true

# ==================== STEP 7: WATCHDOG ====================

log "Step 7: Watchdog — monitoring for 60s..."

WATCH_OK=true
i=1
while [ "$i" -le 12 ]; do
  sleep 5
  RESP=$(wget -qO- "http://localhost:$HEALTH_PORT_MAIN/health" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    log "Watchdog check $i/12: healthy"
  else
    err "Watchdog check $i/12 FAILED: $RESP"
    WATCH_OK=false
    break
  fi
  i=$((i + 1))
done

if [ "$WATCH_OK" != "true" ]; then
  err "Watchdog detected failure! Rolling back..."
  do_rollback

  # Rebuild with old code
  cd "$PROJECT_DIR"
  if docker compose -f "$COMPOSE_FILE" up -d --build 2>&1; then
    log "Rollback successful — old version restored"
    exit 3
  else
    err "CRITICAL: Rollback build also failed!"
    exit 4
  fi
fi

# ==================== SUCCESS ====================

log "Deploy successful! Cleaning up backup..."
rm -rf "$BACKUP_DIR"
log "Done. Rick is running with the new code."
exit 0
