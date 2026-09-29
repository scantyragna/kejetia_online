// Product-photo pipeline.
//
//   • Real mode  : compress on the client (canvas → JPEG, target < 500 KB),
//                  upload to the public `product-images` Storage bucket under
//                  `{storeId}/{timestamp}-{n}.jpg`, and store the public URL
//                  array on the product row. Keeps the 1 GB bucket usable and
//                  the 500 MB database free of image blobs (Postgres rows cap
//                  near 1 MB — base64 photos would corrupt and exhaust both).
//   • Mock mode  : no network — files are read as data URLs (what the old
//                  code did), so local dev and previews work unchanged.
import { getSupabase, inMockMode } from '@/lib/supabase'

const MAX_SOURCE_BYTES = 10 * 1024 * 1024 // don't even read absurd files
const MAX_DIM = 1200 // longest edge, px
const START_QUALITY = 0.82
const MIN_QUALITY = 0.4
const TARGET_BYTES = 500 * 1024 // the free-bucket budget per photo

function readAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = src
  })
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

// Downscale + re-encode a camera photo to a JPEG blob under TARGET_BYTES.
// Safest for the free tier: ~5 images fit in the same space one untouched
// phone photo used to take.
export async function compressImage(file, { maxDim = MAX_DIM, quality = START_QUALITY } = {}) {
  if (file.size > MAX_SOURCE_BYTES) return null
  const src = await readAsDataUrl(file)
  if (!src) return null
  const img = await loadImage(src)
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)

  let blob = await canvasToBlob(canvas, quality)
  while (blob && blob.size > TARGET_BYTES && quality > MIN_QUALITY) {
    quality -= 0.1
    blob = await canvasToBlob(canvas, quality)
  }
  return blob
}

// Preview data URLs for local draft display (and the mock-mode final image).
export async function readMockImages(fileList) {
  const files = Array.from(fileList || []).slice(0, 3)
  const out = await Promise.all(
    files.map(async (file) => (file.size > MAX_SOURCE_BYTES ? null : readAsDataUrl(file)))
  )
  return out.filter(Boolean)
}

// Upload one landmark / store-front photo.
// Mock mode: returns the data URL (no network).
// Real mode: returns the public Storage URL, or null on failure.
export async function uploadLandmarkPhoto(file, ownerKey = 'landmark') {
  const sb = getSupabase()
  if (!sb) return null
  if (typeof file === 'string') return file

  if (inMockMode()) {
    return file && file.size <= MAX_SOURCE_BYTES ? readAsDataUrl(file) : null
  }

  const blob = await compressImage(file)
  if (!blob) return null
  const path = `${ownerKey}/${Date.now()}.jpg`
  const { error } = await sb.storage.from('landmark-photos').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  })
  if (error) {
    console.error('Landmark photo upload failed:', error.message)
    return null
  }
  const { data } = sb.storage.from('landmark-photos').getPublicUrl(path)
  return data?.publicUrl || null
}

// Upload a single square avatar / store-front photo (auto-compressed).
// Returns the public URL or null. Mock mode returns a data URL.
export async function uploadSinglePhoto(file, bucket, ownerKey = 'photo') {
  const sb = getSupabase()
  if (!sb || !file) return null
  if (typeof file === 'string') return file
  if (inMockMode()) {
    return file.size <= MAX_SOURCE_BYTES ? readAsDataUrl(file) : null
  }
  const blob = await compressImage(file)
  if (!blob) return null
  const path = `${ownerKey}/${Date.now()}.jpg`
  const { error } = await sb.storage.from(bucket).upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  })
  if (error) {
    console.error(`${bucket} upload failed:`, error.message)
    return null
  }
  const { data } = sb.storage.from(bucket).getPublicUrl(path)
  return data?.publicUrl || null
}

export const uploadAvatar = (file, userId) => uploadSinglePhoto(file, 'avatars', userId || 'avatar')
export const uploadStorePhoto = (file, storeId) => uploadSinglePhoto(file, 'store-images', storeId || 'store')

// Upload up to 3 photos for a store's product.
// Mock mode: returns the data URLs (no network).
// Real mode: returns public Storage URLs; failed uploads are dropped.
export async function uploadProductImages(files, storeId) {
  const sb = getSupabase()
  if (!sb) return []
  const list = Array.isArray(files) ? files.slice(0, 3) : []
  if (!list.length) return []

  if (inMockMode()) {
    const urls = await Promise.all(list.map((f) => (typeof f === 'string' ? f : readAsDataUrl(f))))
    return urls.filter(Boolean)
  }

  const uploaded = []
  for (let i = 0; i < list.length; i++) {
    const file = list[i]
    if (typeof file === 'string') { uploaded.push(file); continue }
    const blob = await compressImage(file)
    if (!blob) continue
    const path = `${storeId}/${Date.now()}-${i}.jpg`
    const { error } = await sb.storage.from('product-images').upload(path, blob, {
      contentType: 'image/jpeg',
      upsert: false,
    })
    if (error) {
      console.error('Product image upload failed:', error.message)
      continue
    }
    const { data } = sb.storage.from('product-images').getPublicUrl(path)
    if (data?.publicUrl) uploaded.push(data.publicUrl)
  }
  return uploaded
}