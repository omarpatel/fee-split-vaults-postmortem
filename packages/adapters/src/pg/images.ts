/**
 * Image assets over Postgres.
 *
 * Content addressed: (coin_ref, kind, sha256) is unique and the id is minted
 * from it, so re-rendering the same asset is one row. Bytes travel as hex
 * through the driver (`decode($n, 'hex')` in, `encode(bytes, 'hex')` out)
 * rather than as a binary parameter, because the driver surface this package
 * writes against is `string | number | boolean | null` and widening it for one
 * column would loosen every other store's boundary. The sha256 is re-checked
 * against the bytes on read: a row that does not hash to its own id is not
 * served.
 */

import { createHash } from 'node:crypto'
import { IMAGE_KINDS, imageAssetId, type ImageAsset, type ImageAssetStore, type ImageRef } from '@fee-split-vaults/core'
import { SourceUnavailableError } from '../errors.js'
import { enumFromSql, guarded, strFromSql } from './rows.js'
import { countFromSql, type SqlDriver } from './sql.js'

export class PgImageAssetStore implements ImageAssetStore {
  constructor(private readonly driver: SqlDriver) {}

  async get(id: string): Promise<ImageAsset | null> {
    const rows = await guarded('image_asset', () =>
      this.driver.query(
        `SELECT id, coin_ref, kind, mime, width, height, sha256, encode(bytes, 'hex') AS bytes_hex
           FROM image_asset WHERE id = $1`,
        [id],
      ),
    )
    const row = rows[0]
    if (row === undefined) return null
    const f = 'image_asset'
    const bytes = Uint8Array.from(Buffer.from(strFromSql(row.bytes_hex, `${f}.bytes`), 'hex'))
    const sha256 = strFromSql(row.sha256, `${f}.sha256`)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha256) {
      throw new SourceUnavailableError('image_asset', `row ${id} hashes to ${actual}, not its recorded ${sha256}`)
    }
    return {
      id: strFromSql(row.id, `${f}.id`),
      coinRef: strFromSql(row.coin_ref, `${f}.coin_ref`),
      kind: enumFromSql(row.kind, IMAGE_KINDS, `${f}.kind`),
      mime: enumFromSql(row.mime, ['image/png'] as const, `${f}.mime`),
      width: countFromSql(row.width, `${f}.width`),
      height: countFromSql(row.height, `${f}.height`),
      sha256,
      bytes,
    }
  }

  async list(coinRef: string): Promise<readonly ImageRef[]> {
    const rows = await guarded('image_asset', () =>
      this.driver.query('SELECT id, kind FROM image_asset WHERE coin_ref = $1 ORDER BY kind, id', [coinRef]),
    )
    return rows.map((row) => ({
      id: strFromSql(row.id, 'image_asset.id'),
      kind: enumFromSql(row.kind, IMAGE_KINDS, 'image_asset.kind'),
    }))
  }

  async put(asset: ImageAsset): Promise<void> {
    const sha256 = createHash('sha256').update(asset.bytes).digest('hex')
    if (sha256 !== asset.sha256) {
      throw new TypeError(`image asset ${asset.id} claims sha256 ${asset.sha256} but its bytes hash to ${sha256}`)
    }
    const expectedId = imageAssetId(asset.coinRef, asset.kind, sha256)
    if (expectedId !== asset.id) {
      throw new TypeError(`image asset id ${asset.id} does not match its content id ${expectedId}`)
    }
    await guarded('image_asset', () =>
      this.driver.execute(
        `INSERT INTO image_asset (id, coin_ref, kind, mime, width, height, sha256, bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, decode($8, 'hex'))
         ON CONFLICT (id) DO NOTHING`,
        [
          asset.id,
          asset.coinRef,
          asset.kind,
          asset.mime,
          asset.width,
          asset.height,
          sha256,
          Buffer.from(asset.bytes).toString('hex'),
        ],
      ),
    )
  }
}
