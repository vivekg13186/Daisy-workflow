#!/usr/bin/env bash
#
# Build + push Daisy-workflow images to Docker Hub.
#
# Usage:
#   ./scripts/release.sh                # builds + pushes VERSION=$(cat VERSION)
#   VERSION=0.3.0 ./scripts/release.sh  # explicit version
#   DOCKERHUB_USER=otheruser ./scripts/release.sh
#
# What it does:
#   • Logs in to Docker Hub (uses cached `docker login` creds; runs an
#     interactive login if none).
#   • Builds the production backend + frontend images, tags them as
#     <VERSION> and `latest`, pushes both tags.
#   • Builds the dev backend + frontend images, tags them as
#     <VERSION>-dev and `dev`, pushes both tags.
#   • Multi-arch (amd64 + arm64) via buildx — uploads a manifest list
#     so users get the right arch automatically.
#
# Prerequisites:
#   • Docker Desktop or docker-ce 24+.
#   • docker buildx (bundled with recent Docker).
#   • You're logged into Docker Hub (or supply DOCKERHUB_TOKEN env var).

set -euo pipefail

# Resolve paths relative to the repo root, not the CWD the user invoked
# the script from. This means `./scripts/release.sh`, `bash scripts/release.sh`,
# and `cd scripts && ./release.sh` all work the same way.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

DOCKERHUB_USER="${DOCKERHUB_USER:-vivek13186}"
VERSION="${VERSION:-$(cat VERSION 2>/dev/null || echo "0.1.0")}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

if [[ -z "${VERSION}" ]]; then
  echo "VERSION is empty. Set it via env or create a VERSION file at the repo root." >&2
  exit 1
fi

# Pre-flight: make sure the expected build contexts + Dockerfiles exist
# before we spin up buildx. Buildx's own error ("unable to prepare context:
# path 'backend' not found") doesn't make it obvious which file is missing.
for svc in backend frontend; do
  for f in "${svc}" \
           "docker/${svc}.Dockerfile" \
           "docker/${svc}.Dockerfile.dev"; do
    if [[ ! -e "${REPO_ROOT}/${f}" ]]; then
      echo "Missing required path: ${REPO_ROOT}/${f}" >&2
      echo "Are you running this from a partial checkout? Expected layout:" >&2
      echo "  <repo>/backend/      <repo>/docker/backend.Dockerfile      <repo>/docker/backend.Dockerfile.dev" >&2
      echo "  <repo>/frontend/     <repo>/docker/frontend.Dockerfile     <repo>/docker/frontend.Dockerfile.dev" >&2
      exit 1
    fi
  done
done
[[ -e "${REPO_ROOT}/frontend/nginx.conf" ]] || {
  echo "Missing frontend/nginx.conf — the prod frontend image needs it (see docker/frontend.Dockerfile)." >&2
  exit 1
}

echo "→ Releasing Daisy-workflow ${VERSION} to ${DOCKERHUB_USER} on Docker Hub"
echo "  Platforms: ${PLATFORMS}"
echo

# Make sure a buildx builder is active. Setting it up is idempotent.
if ! docker buildx inspect daisy-builder >/dev/null 2>&1; then
  echo "→ Creating buildx builder 'daisy-builder'"
  docker buildx create --name daisy-builder --use --bootstrap
else
  docker buildx use daisy-builder
fi

# Log in if a token is available; otherwise rely on cached creds.
if [[ -n "${DOCKERHUB_TOKEN:-}" ]]; then
  echo "→ Logging into Docker Hub as ${DOCKERHUB_USER}"
  echo "${DOCKERHUB_TOKEN}" | docker login -u "${DOCKERHUB_USER}" --password-stdin
fi

build_and_push() {
  local svc="$1"            # backend | frontend
  local mode="$2"           # prod | dev
  local dockerfile primary secondary

  if [[ "$mode" == "prod" ]]; then
    dockerfile="docker/${svc}.Dockerfile"
    primary="${VERSION}"
    secondary="latest"
  else
    dockerfile="docker/${svc}.Dockerfile.dev"
    primary="${VERSION}-dev"
    secondary="dev"
  fi

  local image="${DOCKERHUB_USER}/daisy-workflow-${svc}"
  echo "→ Building ${image}:${primary} (${mode})"
  docker buildx build \
    --platform "${PLATFORMS}" \
    -t "${image}:${primary}" \
    -t "${image}:${secondary}" \
    -f "${dockerfile}" \
    --push \
    "${svc}"
  echo "  pushed ${image}:${primary}, ${image}:${secondary}"
  echo
}

for svc in backend frontend; do
  build_and_push "${svc}" "prod"
  build_and_push "${svc}" "dev"
done

echo "✓ Done. Pulled with:"
echo "    docker pull ${DOCKERHUB_USER}/daisy-workflow-backend:${VERSION}"
echo "    docker pull ${DOCKERHUB_USER}/daisy-workflow-frontend:${VERSION}"
echo "    docker pull ${DOCKERHUB_USER}/daisy-workflow-backend:dev"
echo "    docker pull ${DOCKERHUB_USER}/daisy-workflow-frontend:dev"
