import { imageAssetId, type ImageAsset, type ImageAssetStore, type ImageRef } from '@fee-split-vaults/core'
import { CreativeError } from './errors.js'

/**
 * Process-local ImageAssetStore. Refuses an asset whose id does not match its
 * own coinRef/kind/sha256, so a list() result can never name bytes that belong
 * to another coin.
 */
export class InMemoryImageAssetStore implements ImageAssetStore {
  private readonly assets = new Map<string, ImageAsset>()

  async get(id: string): Promise<ImageAsset | null> {
    return this.assets.get(id) ?? null
  }

  async list(coinRef: string): Promise<readonly ImageRef[]> {
    const refs: ImageRef[] = []
    for (const asset of this.assets.values()) {
      if (asset.coinRef === coinRef) refs.push({ id: asset.id, kind: asset.kind })
    }
    return refs
  }

  async put(asset: ImageAsset): Promise<void> {
    const expected = imageAssetId(asset.coinRef, asset.kind, asset.sha256)
    if (asset.id !== expected) {
      throw new CreativeError('asset_id_mismatch', `id ${asset.id} does not match ${expected}`, 'id')
    }
    this.assets.set(asset.id, asset)
  }
}
