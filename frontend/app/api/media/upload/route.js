// Media upload — stores photo bytes in Postgres (media table) instead of
// an object store. The client sends base64 (already compressed to <500 KB by
// lib/media.js); the server decodes to BYTEA.
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { readTokenFromHeaders, getUserFromToken } from '@/lib/auth-server'

export const runtime = 'nodejs'

const ALLOWED_BUCKETS = new Set(['product-images', 'landmark-photos', 'avatars', 'store-images'])
const MAX_DECODED_BYTES = 1 * 1024 * 1024 // hard cap, 1 MB

export async function POST(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: { message: 'Invalid request body.' } }, { status: 400 })
  }

  const bucket = body?.bucket
  const key = String(body?.key || '')
  const contentType = String(body?.contentType || 'image/jpeg')
  const dataUrl = String(body?.data || '')
  const ownerId = body?.ownerId || null

  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: { message: 'Unknown bucket.' } }, { status: 400 })
  }
  if (!key || key.length > 300) {
    return NextResponse.json({ error: { message: 'Invalid image path.' } }, { status: 400 })
  }

  const token = readTokenFromHeaders(request.headers)
  const user = await getUserFromToken(token)
  if (!user) {
    return NextResponse.json({ error: { message: 'You must be signed in to upload.' } }, { status: 401 })
  }

  // Accept a raw base64 string or a data: URL.
  const comma = dataUrl.indexOf(',')
  const b64 = comma > -1 ? dataUrl.slice(comma + 1) : dataUrl
  let bytes
  try {
    bytes = Buffer.from(b64, 'base64')
  } catch {
    return NextResponse.json({ error: { message: 'Could not decode image.' } }, { status: 400 })
  }
  if (!bytes.length || bytes.length > MAX_DECODED_BYTES) {
    return NextResponse.json({ error: { message: 'Image is empty or too large.' } }, { status: 400 })
  }

  let sql
  let params
  if (ownerId && typeof ownerId === 'string' && /^[0-9a-f-]{36}$/i.test(ownerId)) {
    sql = `INSERT INTO media (bucket, key, content_type, data, owner_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (bucket, key) DO UPDATE SET data = EXCLUDED.data, content_type = EXCLUDED.content_type
           RETURNING id`
    params = [bucket, key, contentType, bytes, ownerId]
  } else {
    sql = `INSERT INTO media (bucket, key, content_type, data)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (bucket, key) DO UPDATE SET data = EXCLUDED.data, content_type = EXCLUDED.content_type
           RETURNING id`
    params = [bucket, key, contentType, bytes]
  }

  try {
    const result = await query(sql, params)
    // Keep slashes real (segment-encoded like the client's getPublicUrl) so the
    // returned URL resolves through the /api/media/[bucket]/[...path] catch-all.
    const publicPath = String(key).split('/').map(encodeURIComponent).join('/')
    return NextResponse.json({
      data: { publicUrl: `/api/media/${encodeURIComponent(bucket)}/${publicPath}` },
      error: null,
    }, { status: 200 })
  } catch (err) {
    console.error('[media] upload failed:', err.message)
    return NextResponse.json({ error: { message: 'Upload failed.' } }, { status: 500 })
  }
}