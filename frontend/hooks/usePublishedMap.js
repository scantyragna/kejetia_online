// usePublishedMap — the public read side of the crowdsourced map.
//
// Fetches only PUBLISHED landmarks + walkways (the API enforces that; a
// signed-out visitor can never be handed a draft), then keeps them fresh
// over the realtime poll so an admin approval appears on the shopper's map
// within ~2 s without a refresh.
//
// Used by the public map surfaces (store page map tab, search map view).
// The Studio and Admin pages deliberately do NOT use this — they have their
// own drafts-aware feeds.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSupabase } from '@/lib/supabase'
import { registerCommunityWalkways } from '@/lib/kejetia-graph'

const REFRESH_MS = 60 * 1000 // safety net even without events

export function usePublishedMap({ enabled = true } = {}) {
  const [landmarks, setLandmarks] = useState([])
  const [walkways, setWalkways] = useState([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    const sb = getSupabase()
    if (!sb) return
    // Each query is isolated: an older DB missing the walkways table (before
    // migrate ran) must not take the landmarks down with it.
    const [{ data: lm }, { data: ww }] = await Promise.all([
      sb
        .from('landmarks')
        .select('*')
        .eq('status', 'published')
        .limit(300)
        .catch(() => ({ data: [] })),
      sb
        .from('walkways')
        .select('*')
        .eq('status', 'published')
        .limit(300)
        .catch(() => ({ data: [] })),
    ])
    if (!mountedRef.current) return
    setLandmarks(lm || [])
    setWalkways(ww || [])
    // Feed confirmed walkways into the in-market routing graph, so approved
    // paths improve everybody's turn-by-turn directions (not just the picture
    // on the map). Idempotent — re-registering is a no-op.
    try {
      registerCommunityWalkways(ww || [])
    } catch (err) {
      console.warn('Could not register community walkways for routing:', err?.message || err)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined
    mountedRef.current = true
    refresh()
    const sb = getSupabase()
    if (!sb) return undefined
    const channel = sb
      .channel('published-map')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'landmarks' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walkways' }, refresh)
      .subscribe()
    const t = setInterval(refresh, REFRESH_MS)
    return () => {
      mountedRef.current = false
      clearInterval(t)
      const s2 = getSupabase()
      if (s2) s2.removeChannel(channel)
    }
  }, [enabled, refresh])

  return { landmarks, walkways, loading, refresh }
}
