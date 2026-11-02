import type { Collection } from "mongodb";

export interface AdminPortalNonceRecord {
  _id: string;
  expiresAt: Date;
}

export const ADMIN_PORTAL_NONCE_LIFETIME_MS = 120_000;

export async function claimAdminPortalNonce(
  nonces: Pick<Collection<AdminPortalNonceRecord>, "insertOne" | "replaceOne">,
  nonceKey: string,
  now: number,
): Promise<boolean> {
  const nonceDocument: AdminPortalNonceRecord = {
    _id: nonceKey,
    expiresAt: new Date(now + ADMIN_PORTAL_NONCE_LIFETIME_MS),
  };

  try {
    await nonces.insertOne(nonceDocument);
    return true;
  } catch (insertError) {
    const code =
      typeof insertError === "object" && insertError !== null && "code" in insertError
        ? insertError.code
        : undefined;
    if (code !== 11000) throw insertError;

    const replaced = await nonces.replaceOne(
      { _id: nonceKey, expiresAt: { $lte: new Date(now) } },
      nonceDocument,
    );
    return replaced.modifiedCount === 1;
  }
}
