#!/usr/bin/env bash
# Build the engine and API images from this checkout and push them to the study's ECR repos.
# The tag is the git commit (plus -dirty), written to deploy/.out/image-tag for render.ts.
#
#   deploy/images.sh [tag]
#
# Needs docker and the AWS CLI (credentials of the main account; AWS_PROFILE is honoured).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
inv="$here/inventory.json"
[[ -f "$inv" ]] || { echo "missing $inv: run node deploy/inventory.ts" >&2; exit 1; }

tag="${1:-$(git -C "$root" describe --always --dirty)}"
region="$(jq -r .region "$inv")"
registry="$(jq -r .registry "$inv")"

aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"

for name in engine api; do
  repo="$(jq -r ".repositories.$name" "$inv")"
  dockerfile="$root/routing-engine/Dockerfile"
  [[ $name == api ]] && dockerfile="$root/api/Dockerfile"
  # linux/amd64: the study runs on m6i/m7i (x86)
  docker build --platform linux/amd64 -f "$dockerfile" -t "$repo:$tag" "$root"
  docker push "$repo:$tag"
done

mkdir -p "$here/.out"
echo "$tag" > "$here/.out/image-tag"
echo "pushed tag $tag"
