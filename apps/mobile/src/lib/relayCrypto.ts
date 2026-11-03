import * as ExpoCrypto from "expo-crypto";

if (typeof globalThis.crypto?.getRandomValues !== "function") {
  const target = globalThis.crypto ?? {};
  Object.defineProperty(target, "getRandomValues", {
    value: <T extends ArrayBufferView>(array: T): T => {
      if (array.byteLength > 65536) throw new Error("Random byte request is too large.");
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
        ExpoCrypto.getRandomBytes(array.byteLength),
      );
      return array;
    },
  });
  if (!globalThis.crypto)
    Object.defineProperty(globalThis, "crypto", { value: target, configurable: true });
}
