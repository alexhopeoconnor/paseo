#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mode=${1:-check}
[[ $# == 0 ]] || shift
ref=
if [[ ${1:-} == --ref ]]; then ref=${2:?Missing source commit}; shift 2; fi
[[ ${1:-} != -- ]] || shift
case "$mode" in
  check) [[ -z $ref ]] || { echo 'check stages the current working tree' >&2; exit 2; } ;;
  package|baseline) [[ $ref =~ ^[0-9a-f]{40}$ && $# == 0 ]] || { echo 'Use package|baseline --ref FULL_COMMIT' >&2; exit 2; } ;;
  *) echo 'Usage: fork-build.sh check [-- COMMAND...] | package|baseline --ref FULL_COMMIT' >&2; exit 2 ;;
esac
source_commit=$(git -C "$repo" rev-parse "${ref:-HEAD}^{commit}")
if [[ $mode == package ]]; then
  policy=$(git -C "$repo" show "$source_commit:fork-release.json")
else
  policy=$(cat "$repo/fork-release.json")
fi
image=$(jq -er '.builderImage | select(test("^sha256:[0-9a-f]{64}$"))' <<< "$policy")
[[ $(docker image inspect --format '{{.Id}}' "$image") == "$image" ]]
build_uid=$(id -u)
build_gid=$(id -g)
[[ $build_uid != 0 ]] || { echo 'Run source builds as an unprivileged user' >&2; exit 1; }
build_root=${XDG_CACHE_HOME:-$HOME/.cache}/paseo-builds
state_root=${XDG_STATE_HOME:-$HOME/.local/state}/paseo-builds
mkdir -p "$build_root/work" "$build_root/cache" "$state_root/artifacts" "$state_root/logs"
exec 9>"$build_root/build.lock"
flock -n 9 || { echo 'Another Paseo build is using this cache' >&2; exit 1; }
# Check logs are disposable. Package/baseline logs follow retained release evidence.
python3 - "$state_root/logs" <<'PY'
import pathlib, sys
logs = sorted(pathlib.Path(sys.argv[1]).glob("check-*.log"), key=lambda path: path.stat().st_mtime, reverse=True)
for log in logs[19:]:
    if log.is_file() and not log.is_symlink():
        log.unlink()
PY
if [[ $mode == package ]]; then
  [[ -z $(git -C "$repo" status --porcelain) ]] || { echo 'Release builds require a clean checkout' >&2; exit 1; }
  [[ $source_commit == "$ref" ]]
  [[ $(git -C "$repo" rev-parse HEAD) == "$source_commit" ]] || {
    echo 'Check out the signed source commit before packaging it' >&2; exit 1;
  }
  version=$(jq -er '.runtimeVersion' <<< "$policy")
  python3 - "$state_root/artifacts" "$version" <<'PY'
import json, pathlib, sys
for record in pathlib.Path(sys.argv[1]).glob("package-*/provenance.json"):
    if json.loads(record.read_text()).get("runtimeVersion") == sys.argv[2]:
        raise SystemExit(f"Release version already has an accepted artifact: {record.parent}. Reuse those bytes or select a new version.")
PY
fi
if [[ $mode == baseline && $ref != 8938fde3c713143f12eacbdd60c11fdfc0be0fb1 ]]; then
  echo 'The baseline is the reviewed official 0.15.0 commit' >&2; exit 1
fi
build_id="$mode-$(date -u +%Y%m%dT%H%M%SZ)-${source_commit:0:12}"
stage="$build_root/work/$build_id"
[[ $mode != check ]] || stage="$build_root/work/check"
output="$state_root/artifacts/$build_id"
log="$state_root/logs/$build_id.log"
mkdir "$output"
[[ ! -L $stage ]] || { echo 'Staging checkout cannot be a symlink' >&2; exit 1; }
# Source becomes a root-owned installation. Keep cache/output parents private, but
# materialize public runtime inputs with readable modes instead of the host's 077.
(
  umask 022
  if [[ ! -d $stage/.git ]]; then
    git clone --quiet --no-hardlinks --no-checkout "$repo" "$stage"
  else
    git -C "$stage" fetch --quiet "$repo" "$source_commit"
  fi
  git -C "$stage" -c core.hooksPath=/dev/null checkout --quiet --force --detach "$source_commit"
)
if [[ $mode == check ]]; then
  # Transfer source only; generated files and prepare hooks stay in the staging clone.
  python3 - "$repo" "$stage" <<'PY'
import json, os, pathlib, shutil, subprocess, sys
source, stage = map(pathlib.Path, sys.argv[1:])
paths = subprocess.check_output(["git", "-C", str(source), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split(b"\0")
inventory = stage / ".fork-source-files.json"
if inventory.is_symlink():
    raise ValueError("Staging inventory cannot be a symlink")
current = {os.fsdecode(item) for item in paths if item}
previous = set(json.loads(inventory.read_text())) if inventory.exists() else set()
def destination(relative):
    parts = pathlib.PurePosixPath(relative)
    if parts.is_absolute() or ".." in parts.parts:
        raise ValueError("Unsafe source path")
    parent = stage
    for part in parts.parts[:-1]:
        parent /= part
        if parent.is_symlink():
            raise ValueError(f"Staging path traverses a symlink: {relative}")
    return stage / relative
for relative in previous - current:
    destination(relative).unlink(missing_ok=True)
for item in paths:
    if not item:
        continue
    relative = os.fsdecode(item)
    src, dst = source / relative, destination(relative)
    if not src.exists() and not src.is_symlink():
        dst.unlink(missing_ok=True)
        continue
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_symlink():
        dst.unlink()
    if src.is_symlink():
        dst.unlink(missing_ok=True)
        dst.symlink_to(os.readlink(src))
    else:
        shutil.copy2(src, dst)
        dst.chmod(0o755 if src.stat().st_mode & 0o111 else 0o644)
inventory.write_text(json.dumps(sorted(current)))
PY
fi
# The baseline predates this recipe. Supply only driver/inspection tooling and
# provenance inputs; the legacy application must still pass the current gate.
if [[ $mode == baseline ]]; then
  cp "$repo/scripts/fork-build.mjs" "$stage/scripts/fork-build.mjs"
  cp "$repo/fork-release.json" "$stage/fork-release.json"
  for inspection_input in .gitleaks.toml scripts/check-publication.sh scripts/check-publication.py \
    scripts/publication-scanner.json scripts/publication-exceptions.json scripts/publication-pruned-files.json; do
    cp "$repo/$inspection_input" "$stage/$inspection_input"
  done
fi
container_args=(--rm --init --user "$build_uid:$build_gid" --shm-size=2g
  --mount "type=bind,src=$stage,dst=/work"
  --mount "type=bind,src=$build_root/cache,dst=/cache"
  --mount "type=bind,src=$output,dst=/out" --workdir /work
  --env "PASEO_BUILD_SOURCE=$source_commit" --env "PASEO_BUILD_BASELINE=$([[ $mode == baseline ]] && echo 1 || echo 0)"
  --env "PASEO_BUILD_IMAGE=$image"
  --env NODE_OPTIONS=--max-old-space-size=16384)
echo "Build: $build_id"
echo "Staging: $stage"
echo "Output: $output"
echo "Log: $log"
docker run "${container_args[@]}" "$image" bash -euc '
  umask 022
  mode=$1; shift
  if [[ $mode == package ]]; then node scripts/fork-build.mjs stamp; fi
  dependency_key=$(node scripts/fork-build.mjs dependency-key)
  if [[ ! -d node_modules || ! -f .fork-dependencies || $(cat .fork-dependencies) != "$dependency_key" ]]; then
    npm ci
    printf "%s\n" "$dependency_key" > .fork-dependencies
  fi
  if [[ $mode == check ]]; then
    if [[ $# != 0 ]]; then "$@"; else
      npm run build:app-deps
      npm run build:server
      npm run typecheck
      npm run lint
    fi
  else
    PASEO_DESKTOP_SMOKE=1 PASEO_DESKTOP_SMOKE_ARTIFACT_DIR=/out/smoke npm run build:desktop -- --publish never --linux deb --x64
    node scripts/fork-build.mjs candidate
  fi
' bash "$mode" "$@" 2>&1 | tee "$log"
if [[ $mode != check ]]; then
  # Only the host orchestrates containers. The build container has no Docker socket.
  mapfile -d '' packages < <(find "$output" -maxdepth 1 -type f -name '*.deb' -print0)
  [[ ${#packages[@]} == 1 ]] || { echo 'Expected one unaccepted package candidate' >&2; exit 1; }
  bash "$repo/scripts/check-publication.sh" package --file "${packages[0]}" \
    --report "$output/publication.json" 2>&1 | tee -a "$log"
  docker run "${container_args[@]}" "$image" node scripts/fork-build.mjs record 2>&1 | tee -a "$log"
fi
if [[ $mode != check ]]; then rm -rf -- "$stage"; fi
echo "Completed: $output (log: $log)"
