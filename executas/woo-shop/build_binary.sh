#!/usr/bin/env bash
# Build releasable, zero-dependency Anna Executa binaries (per the Binary
# Distribution guide) using @yao-pkg/pkg. One local run cross-builds every
# platform — no CI needed.
#
#   dist/<tool_id>-<platform>.tar.gz
#     ├── bin/<tool_id>     standalone executable (Node embedded; no host Node needed)
#     └── manifest.json     name=<tool_id>, runtime.binary.entrypoint=bin/<tool_id>
#
# Why pkg and not Node SEA: Node SEA binaries segfault on macOS 26.x; @yao-pkg/pkg
# embeds a prebuilt Node and ad-hoc-signs the Mach-O, so it runs on Apple Silicon.
#
# Requires: node + npx (esbuild + @yao-pkg/pkg fetched on demand).
set -euo pipefail

TOOL_ID="tool-fahdmurtaza-woo-shop-n8sy5atm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-${SCRIPT_DIR}/dist}"
cd "$SCRIPT_DIR"
VERSION="$(node -e "process.stdout.write(require('./package.json').version)")"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# pkg target → Anna platform key
declare -a TARGETS=(
  "node22-macos-arm64:darwin-arm64"
  "node22-macos-x64:darwin-x86_64"
  "node22-linux-x64:linux-x86_64"
  "node22-linux-arm64:linux-aarch64"
)

echo "Bundling index.js → bundle.cjs ..."
npx --yes esbuild index.js --bundle --platform=node --target=node18 --format=cjs --outfile="$WORK/bundle.cjs" >/dev/null 2>&1

for entry in "${TARGETS[@]}"; do
  PKG_TARGET="${entry%%:*}"; PLATFORM="${entry##*:}"
  echo "=== $PLATFORM ($PKG_TARGET) ==="
  npx --yes @yao-pkg/pkg "$WORK/bundle.cjs" --targets "$PKG_TARGET" --output "$WORK/bin-$PLATFORM" >/dev/null 2>&1

  PKGROOT="$WORK/pkg-$PLATFORM"; mkdir -p "$PKGROOT/bin"
  cp "$WORK/bin-$PLATFORM" "$PKGROOT/bin/$TOOL_ID"
  chmod 0755 "$PKGROOT/bin/$TOOL_ID"
  cat > "$PKGROOT/manifest.json" <<JSON
{
  "name": "$TOOL_ID",
  "display_name": "WooCommerce Shop",
  "version": "$VERSION",
  "description": "Search products and manage the cart on a WooCommerce store.",
  "runtime": {
    "binary": {
      "entrypoint": { "default": "bin/$TOOL_ID" },
      "permissions": { "bin/$TOOL_ID": "0o755" }
    }
  }
}
JSON

  ARCHIVE="$OUT/${TOOL_ID}-${PLATFORM}.tar.gz"
  rm -f "$ARCHIVE"
  tar -czf "$ARCHIVE" -C "$PKGROOT" bin manifest.json
  SHA="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  SZ="$(stat -f%z "$ARCHIVE" 2>/dev/null || stat -c%s "$ARCHIVE")"
  echo "  → $(du -sh "$ARCHIVE" | cut -f1)  $ARCHIVE"
  echo "    sha256=$SHA size=$SZ"
done
echo
echo "=== Done. Archives in $OUT ==="
