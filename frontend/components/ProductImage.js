'use client'

// ---------------------------------------------------------------------------
// ProductImage — Jumia-style auto-minted product photo.
//
// Every seller photo (portrait, landscape, any size) is normalized into the
// same square white tile, exactly like jumia.com:
//   - 1:1 square, pure white background, image letterboxed with `contain`
//   - centered, padded, never cropped, never stretched
//   - lazy-loaded + fade-in, async decode, non-draggable
//   - never a broken-image icon: missing/failed photos fall back to a soft
//     grey art tile with the category vector icon
//
// Parent cards render badges (discount / stock) as overlays on top of this.
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { Icon, iconNameFor } from '@/components/icons'

export default function ProductImage({
  src,
  row,
  icon,
  alt = '',
  eager = false,
  style,
  iconSize,
  tint,
}) {
  const source = src || row?.images?.[0] || row?.image_url || ''
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const showPhoto = Boolean(source) && !failed

  const fallback = (
    <span className="ko-pimg-fallback" aria-hidden="true">
      <Icon
        name={icon || iconNameFor(row, 'shopping-bag')}
        size={iconSize || 48}
        color={tint || '#cbd5e1'}
      />
    </span>
  )

  if (!showPhoto) {
    return (
      <div className="ko-pimg" style={style} role="img" aria-label={alt}>
        {fallback}
      </div>
    )
  }

  return (
    <div className="ko-pimg" style={style}>
      {!loaded && fallback}
      <img
        src={source}
        alt={alt}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        className={`ko-pimg-img${loaded ? ' ko-pimg-loaded' : ''}`}
        onLoad={() => setLoaded(true)}
        onError={() => {
          setFailed(true)
          setLoaded(false)
        }}
      />
    </div>
  )
}
