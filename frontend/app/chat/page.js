'use client'

import { useCallback, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabase } from '@/lib/supabase'
import { useAuth } from '@/context/auth-context'
import Header from '@/components/Header'

export default function ChatListPage() {
  const { user, profile, loading: authLoading, signOut } = useAuth()
  const router = useRouter()
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchConversations = useCallback(async () => {
    if (!user) return
    if (profile?.role === 'seller') {
      // Seller: conversations for stores they own
      const supabase = getSupabase()
      if (!supabase) return
      const { data: stores } = await supabase
        .from('stores')
        .select('id')
        .eq('owner_id', user.id)

      if (stores && stores.length > 0) {
        const storeIds = stores.map(s => s.id)
        const { data: convs } = await supabase
          .from('conversations')
          .select('*, stores(name, phone), buyer:profiles!buyer_id(full_name)')
          .in('store_id', storeIds)
          .order('created_at', { ascending: false })
        setConversations(convs || [])
      } else {
        setConversations([])
      }
    } else {
      // Buyer: their conversations
      const supabase = getSupabase()
      if (!supabase) return
      const { data: convs } = await supabase
        .from('conversations')
        .select('*, stores(name, phone, image_url, latitude, longitude)')
        .eq('buyer_id', user.id)
        .order('created_at', { ascending: false })
      setConversations(convs || [])
    }
    setLoading(false)
  }, [user, profile])

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/auth/login')
      return
    }
    fetchConversations()
  }, [authLoading, user, fetchConversations, router])

  // Live sync — when a buyer starts a conversation, the seller's message list
  // updates without waiting for a refresh.
  useEffect(() => {
    if (!user) return
    const supabase = getSupabase()
    if (!supabase) return
    const channel = supabase
      .channel('chat-list-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, fetchConversations)
      .subscribe()
    return () => {
      const sb = getSupabase()
      if (sb) sb.removeChannel(channel)
    }
  }, [user, fetchConversations])

  if (authLoading || loading) {
    return <div style={styles.loading}><img src="/logo.svg" alt="Loading..." style={{ height: 32 }} /></div>
  }

  return (
    <div style={styles.page}>
      <Header user={user} profile={profile} onSignOut={signOut} />
      <div className="container" style={styles.content}>
        <h1 style={styles.title}>Messages</h1>

        {conversations.length === 0 ? (
          <p style={styles.empty}>No conversations yet. Find a store and start chatting!</p>
        ) : (
          <div style={styles.list}>
            {conversations.map((conv) => (
              <a
                key={conv.id}
                // Conversation id, not store id: the thread page accepts either,
                // but only the conversation id lets a SELLER open a specific
                // buyer's thread (by store id they'd land in a store-level view
                // that has no conversation of their own).
                href={`/chat/${conv.id}`}
                style={styles.convCard}
              >
                <div style={styles.convIcon}>
                  {conv.stores?.name?.[0] || '?'}
                </div>
                <div style={styles.convInfo}>
                  <strong style={styles.convName}>{conv.stores?.name || 'Store'}</strong>
                  <p style={styles.convSub}>
                    {profile?.role === 'seller'
                      ? `Buyer: ${conv.buyer?.full_name || 'Unknown'}`
                      : conv.stores?.phone || ''}
                  </p>
                </div>
                <span style={styles.convArrow}>→</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg)' },
  loading: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  content: { padding: '40px 24px', maxWidth: 600, margin: '0 auto' },
  title: { fontSize: 28, fontWeight: 800, marginBottom: 24, color: 'var(--ink)', letterSpacing: '-0.5px' },
  empty: { textAlign: 'center', padding: 60, color: 'var(--gray-600)', fontSize: 16 },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  convCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: 16,
    background: 'var(--white)',
    borderRadius: 12,
    border: '1px solid var(--border)',
    textDecoration: 'none',
    transition: 'all 0.2s ease',
  },
  convIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    background: 'var(--navy)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--accent)',
    flexShrink: 0,
  },
  convInfo: { flex: 1, minWidth: 0 },
  convName: { fontSize: 16, fontWeight: 600, color: 'var(--gray-800)' },
  convSub: { fontSize: 13, color: 'var(--gray-500)' },
  convArrow: { color: 'var(--accent-700)', fontSize: 18, fontWeight: 700 },
}

