/// Pluggable off-chain metadata upload for the launch aggregator. External launchpads
/// (Pump.fun, LetsBonk) need the token's metadata JSON pinned to IPFS BEFORE the create
/// transaction; the JSON's URI is what goes on-chain. This wraps that upload behind an
/// interface so an operator can swap Pinata for any pinning service.

export interface TokenMetadataContent {
  name: string;
  symbol: string;
  description?: string;
  /// The token image. Uploaded first; its IPFS URL is embedded into the JSON.
  image?: Blob;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface MetadataUploader {
  /// Upload the image (if any) + the metadata JSON, returning the JSON's IPFS URI.
  uploadMetadata(content: TokenMetadataContent): Promise<string>;
}

const PINATA_FILES = "https://uploads.pinata.cloud/v3/files";

/// Pinata-backed uploader. `jwt` is a Pinata API JWT (the OPERATOR's secret, never the
/// dev's wallet). Uploads the image, then the metadata JSON that references it.
export function pinataUploader(jwt: string): MetadataUploader {
  if (!jwt) throw new Error("pinataUploader: a Pinata JWT is required");

  async function putFile(file: Blob, name: string): Promise<string> {
    const form = new FormData();
    form.append("network", "public");
    form.append("file", file, name);
    const res = await fetch(PINATA_FILES, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Pinata upload failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: { cid?: string } };
    const cid = json.data?.cid;
    if (!cid) throw new Error("Pinata upload returned no CID");
    return `https://ipfs.io/ipfs/${cid}`;
  }

  return {
    async uploadMetadata(content: TokenMetadataContent): Promise<string> {
      let imageUri = "";
      if (content.image) {
        imageUri = await putFile(content.image, `${content.symbol}-image`);
      }
      const json = {
        name: content.name,
        symbol: content.symbol,
        description: content.description ?? "",
        image: imageUri,
        showName: true,
        ...(content.twitter ? { twitter: content.twitter } : {}),
        ...(content.telegram ? { telegram: content.telegram } : {}),
        ...(content.website ? { website: content.website } : {}),
      };
      const blob = new Blob([JSON.stringify(json)], { type: "application/json" });
      return putFile(blob, `${content.symbol}-metadata.json`);
    },
  };
}

/// Default uploader from `VITE_PINATA_JWT`, or null when unset (the caller must then pass
/// an explicit uploader, or a pre-built `metadataUri`).
export function defaultUploader(): MetadataUploader | null {
  const jwt = import.meta.env.VITE_PINATA_JWT as string | undefined;
  return jwt ? pinataUploader(jwt) : null;
}
