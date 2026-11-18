#!/usr/bin/env bash
set -euo pipefail

# A host-side content check only. JavaScript checks remain in the Docker wrapper.
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
hook=$(git -C "$repo" rev-parse --path-format=absolute --git-path hooks/pre-commit)
if [[ -e $hook || -L $hook ]]; then
  if [[ -f $hook && ! -L $hook ]] && grep -q '^# Paseo publication-only pre-commit hook$' "$hook"; then
    echo 'Publication hook is already installed.'
    exit 0
  fi
  echo 'Existing pre-commit hook preserved. Add bash scripts/check-publication.sh staged to its existing workflow.' >&2
  exit 1
fi
mkdir -p -- "$(dirname -- "$hook")"
temporary=$(mktemp "$(dirname -- "$hook")/.publication-hook.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary" <<'HOOK'
#!/usr/bin/env bash
# Paseo publication-only pre-commit hook
set -euo pipefail
cd -- "$(git rev-parse --show-toplevel)"
exec bash scripts/check-publication.sh staged
HOOK
chmod 0755 "$temporary"
# Do not overwrite a hook created while this installer was running.
ln -- "$temporary" "$hook"
echo 'Installed the staged publication check; no build or application tests run on commit.'
