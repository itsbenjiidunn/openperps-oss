// Provide Node's `Buffer` global in the browser before any Solana code runs.
// @solana/web3.js and the wallet adapters reference `Buffer` at runtime
// (e.g. PublicKey.toBuffer, transaction serialization) and browsers ship none.
// Importing this module first in main.tsx guarantees the global is installed
// before any other import is evaluated.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}
