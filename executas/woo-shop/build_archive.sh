#!/usr/bin/env bash
# Build the cross-platform Anna binary archive for woo-shop.
#
#   dist/<tool_id>.tar.gz
#     ├── bin/<tool_id>      node-launcher shim (runs lib via the host Node)
#     ├── lib/woo-shop.cjs   esbuild bundle of index.js + woo-client.js
#     └── manifest.json      name=<tool_id>, runtime.binary.entrypoint=bin/<tool_id>
#
# Why a node-launcher instead of a Node SEA binary:
#   * The bin-shim NAME comes from manifest.json `name` (the tool_id) — NOT the
#     scoped npm package name. That fixes "unsafe bin name: bin link escapes
#     bin_dir: name='@scope/pkg'" on a clean install.
#   * One archive runs on macOS + Linux via the host's Node — no per-platform
#     binary, and no Node-SEA segfault (SEA crashes on macOS 26.x).
#
# Requires: node + npx (esbuild from devDependencies). Run from this dir.
set -euo pipefail

TOOL_ID="tool-fahdmurtaza-woo-shop-n8sy5atm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-${SCRIPT_DIR}/dist}"
cd "$SCRIPT_DIR"
VERSION="$(node -e "process.stdout.write(require('./package.json').version)")"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/pkg/bin" "$WORK/pkg/lib" "$OUT"

[ -f node_modules/.bin/esbuild ] || npm ci --include=dev >/dev/null 2>&1 || npm install --include=dev >/dev/null 2>&1

echo "Bundling index.js → lib/woo-shop.cjs ..."
node_modules/.bin/esbuild index.js --bundle --platform=node --target=node18 --format=cjs \
  --outfile="$WORK/pkg/lib/woo-shop.cjs"

cat > "$WORK/pkg/bin/$TOOL_ID" <<'SH'
#!/bin/sh
# Anna executa launcher: run the bundled JS with the host's Node.
DIR="${EXECUTA_HOME:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
for n in node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.volta/bin/node" "$HOME/.nvm/versions/node"/*/bin/node; do
  if command -v "$n" >/dev/null 2>&1; then exec "$n" "$DIR/lib/woo-shop.cjs" "$@"; fi
  [ -x "$n" ] && exec "$n" "$DIR/lib/woo-shop.cjs" "$@"
done
echo "anna woo-shop: Node.js not found on PATH" >&2
exit 127
SH
chmod 0755 "$WORK/pkg/bin/$TOOL_ID"

cat > "$WORK/pkg/manifest.json" <<JSON
{
  "name": "$TOOL_ID",
  "version": "$VERSION",
  "runtime": {
    "binary": {
      "entrypoint": { "default": "bin/$TOOL_ID" },
      "permissions": { "bin/$TOOL_ID": "0o755" }
    }
  }
}
JSON

echo "Smoke test:"
echo '{"jsonrpc":"2.0","id":1,"method":"describe","params":{}}' | sh "$WORK/pkg/bin/$TOOL_ID" \
  | grep -q '"display_name"' && echo "  ✓ describe OK" || { echo "  ✗ describe failed"; exit 1; }

ARCHIVE="$OUT/${TOOL_ID}.tar.gz"
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" -C "$WORK/pkg" bin lib manifest.json
echo "→ $(du -sh "$ARCHIVE" | cut -f1)  $ARCHIVE"
echo "  sha256 $(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
