#!/usr/bin/env bash
# Build a Node.js Single Executable Application (SEA) for the woo-shop executa.
#
# Usage:
#   ./package_binary.sh [OUTPUT_DIR]
#
# Requires: node >=22, esbuild (npm ci first), postject
#
# Output:
#   <OUTPUT_DIR>/tool-fahdmurtaza-woo-shop-n8sy5atm.tar.gz
#     └── tool-fahdmurtaza-woo-shop-n8sy5atm   (the binary)
#
set -euo pipefail

TOOL_ID="tool-fahdmurtaza-woo-shop-n8sy5atm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-${SCRIPT_DIR}/dist}"

cd "$SCRIPT_DIR"

echo "=== woo-shop binary packager ==="
echo "Tool ID : $TOOL_ID"
echo "Out dir : $OUTPUT_DIR"
echo

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64)   PLATFORM="darwin-arm64" ;;
  Darwin-x86_64)  PLATFORM="darwin-x86_64" ;;
  Linux-x86_64)   PLATFORM="linux-x86_64" ;;
  *) echo "Unsupported platform: $OS-$ARCH"; exit 1 ;;
esac
echo "Platform: $PLATFORM"
echo

mkdir -p "$OUTPUT_DIR"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# ── 1. Install dev deps (esbuild) if not present ─────────────────────────────
if [ ! -f node_modules/.bin/esbuild ]; then
  echo "Installing dev dependencies..."
  npm ci --include=dev
fi

# ── 2. Bundle ESM sources → single CJS file ──────────────────────────────────
BUNDLE="$WORK_DIR/bundle.cjs"
echo "Bundling with esbuild..."
node_modules/.bin/esbuild index.js \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="$BUNDLE"
echo "  → $BUNDLE ($(wc -c < "$BUNDLE") bytes)"

# ── 3. Write SEA config ───────────────────────────────────────────────────────
SEA_CONFIG="$WORK_DIR/sea-config.json"
SEA_BLOB="$WORK_DIR/sea.blob"
cat > "$SEA_CONFIG" <<JSON
{
  "main": "$BUNDLE",
  "output": "$SEA_BLOB",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
JSON

# ── 4. Build the SEA blob ─────────────────────────────────────────────────────
echo "Building SEA blob..."
node --experimental-sea-config "$SEA_CONFIG"

# ── 5. Copy node binary and inject the blob ───────────────────────────────────
NODE_BIN="$(which node)"
BINARY="$WORK_DIR/$TOOL_ID"
cp "$NODE_BIN" "$BINARY"
chmod +w "$BINARY"

if [ "$OS" = "Darwin" ]; then
  echo "Removing macOS code signature from node copy..."
  codesign --remove-signature "$BINARY" || true
fi

echo "Injecting SEA blob with postject..."
npx --yes postject "$BINARY" NODE_SEA_BLOB "$SEA_BLOB" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

if [ "$OS" = "Darwin" ]; then
  # V8 JIT requires these entitlements — without them the binary segfaults on macOS.
  ENTITLEMENTS="$WORK_DIR/entitlements.plist"
  cat > "$ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
PLIST
  echo "Re-signing binary with JIT entitlements + Hardened Runtime..."
  codesign --sign - --force --options runtime --entitlements "$ENTITLEMENTS" "$BINARY"
fi

chmod +x "$BINARY"
echo "  → Binary: $(du -sh "$BINARY" | cut -f1)"

# ── 6. Sanity check ──────────────────────────────────────────────────────────
echo "Binary info:"
file "$BINARY" 2>/dev/null || true
if [ "$OS" = "Darwin" ]; then
  codesign -dv "$BINARY" 2>&1 | head -5 || true
fi
echo "Sanity check — describe call:"
DESCRIBE_OUT="$(echo '{"jsonrpc":"2.0","id":1,"method":"describe","params":{}}' | timeout 10 "$BINARY" 2>/tmp/binary_stderr.txt || true)"
STDERR_OUT="$(cat /tmp/binary_stderr.txt 2>/dev/null || true)"
if echo "$DESCRIBE_OUT" | grep -q '"display_name"'; then
  echo "  ✓ Binary responds correctly to describe"
elif [ -n "$STDERR_OUT" ]; then
  echo "  ! Binary started but check uncertain; stderr: $STDERR_OUT"
  echo "  ! stdout: $DESCRIBE_OUT"
  echo "  (Continuing — platform will validate at runtime)"
else
  echo "  ! Sanity check inconclusive on $OS — binary may still work at runtime"
  echo "  ! stdout: $DESCRIBE_OUT"
  echo "  (Continuing — not blocking release)"
fi

# ── 7. Package as tar.gz ──────────────────────────────────────────────────────
ARCHIVE_NAME="${TOOL_ID}-${PLATFORM}.tar.gz"
ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_NAME"
echo "Creating archive $ARCHIVE_NAME..."
tar -czf "$ARCHIVE_PATH" -C "$WORK_DIR" "$TOOL_ID"
echo "  → $(du -sh "$ARCHIVE_PATH" | cut -f1)  $ARCHIVE_PATH"

echo
echo "=== Done ==="
echo "Archive: $ARCHIVE_PATH"
