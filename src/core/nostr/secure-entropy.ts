import { getRandomValues } from "expo-crypto";

// NDK's Noble dependency captures the global when its module is evaluated.
if (typeof globalThis.crypto?.getRandomValues !== "function") {
  if (!globalThis.crypto)
    Object.defineProperty(globalThis, "crypto", { value: {} });
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    value: getRandomValues,
  });
}
