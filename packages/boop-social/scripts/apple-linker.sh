#!/bin/bash
set -euo pipefail

# Rust's cdylib export list can include no-mangle symbols from dependencies.
# Scope it to this SDK before handing the final link to Apple's Clang.
export_list=""
expect_list=0
for arg in "$@"; do
  if [[ "$expect_list" == 1 ]]; then
    if [[ "$arg" == "-Xlinker" ]]; then continue; fi
    export_list="${arg#-Wl,}"
    break
  fi
  case "$arg" in
    -Wl,-exported_symbols_list,*)
      export_list="${arg#-Wl,-exported_symbols_list,}"
      break
      ;;
    -Wl,-exported_symbols_list|-exported_symbols_list)
      expect_list=1
      ;;
  esac
done

if [[ -z "$export_list" || ! -f "$export_list" ]]; then
  echo "Rust did not provide a Social cdylib export list" >&2
  exit 1
fi
filtered="${export_list}.boop-social"
grep -E '^_((ffi|uniffi)_boop_social_|UNIFFI_META_(BOOP_SOCIAL_|NAMESPACE_BOOP_SOCIAL$))' "$export_list" > "$filtered"
mv "$filtered" "$export_list"
exec /usr/bin/clang "$@"
