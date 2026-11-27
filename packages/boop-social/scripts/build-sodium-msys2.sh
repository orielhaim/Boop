#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/bin:$PATH"

archive="$(cygpath -u "$1")"
work_dir="$(cygpath -u "$2")"
export BOOP_SODIUM_LLVM_BIN="$(cygpath -u "$3")"
target="$4"
export BOOP_SODIUM_CLANG_TARGET="$5"
jobs="$6"

mkdir -p "$work_dir/source" "$work_dir/tools"
export PATH="$work_dir/tools:$PATH"
cat > "$work_dir/tools/boop-sodium-cc" <<'CC'
#!/usr/bin/env bash
exec "$BOOP_SODIUM_LLVM_BIN/clang.exe" "--target=$BOOP_SODIUM_CLANG_TARGET" "$@"
CC
cat > "$work_dir/tools/boop-sodium-ar" <<'AR'
#!/usr/bin/env bash
exec "$BOOP_SODIUM_LLVM_BIN/llvm-ar.exe" "$@"
AR
cat > "$work_dir/tools/boop-sodium-ranlib" <<'RANLIB'
#!/usr/bin/env bash
exec "$BOOP_SODIUM_LLVM_BIN/llvm-ranlib.exe" "$@"
RANLIB
chmod +x "$work_dir/tools/"boop-sodium-*

cd "$work_dir/source"
tar -xzf "$archive" --strip-components=1
CC=boop-sodium-cc AR=boop-sodium-ar RANLIB=boop-sodium-ranlib \
  ./configure --host="$target" --prefix="$(cygpath -m "$work_dir/installed")" \
  --disable-shared --enable-static --disable-ssp --enable-minimal --disable-dependency-tracking
make -j"$jobs" install
