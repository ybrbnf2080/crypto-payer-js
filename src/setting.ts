import crypto from "crypto"

export const TRON_DERIVATION_PATH = "m/44'/195'/0'/0"
export function sha256ToIndex(input: string, max = 2_147_483_647): number {
  const hash = crypto.createHash("sha256").update(input).digest()
  return hash.readUInt32BE(0) % max
}
