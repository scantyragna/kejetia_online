#!/usr/bin/env node
// Grant a user the Map Admin flag (profiles.is_admin).
//
// This is the ONLY way to create an admin in postgres mode: no signup path,
// API column allowlist or client code can set is_admin — app/api/query/route.js
// deliberately omits it from UPDATE_COLUMNS.profiles. Run it once, by email:
//
//   node scripts/make-admin.mjs you@example.com
//
// Requires DATABASE_URL (same as scripts/migrate.mjs). Safe to re-run.

import pg from 'pg'

const email = String(process.argv[2] || '').trim().toLowerCase()
if (!email) {
  console.error('Usage: node scripts/make-admin.mjs <email>')
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Export it first (same value the app uses).')
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
try {
  await client.connect()
  const { rows } = await client.query(
    `UPDATE profiles SET is_admin = TRUE
      WHERE id = (SELECT id FROM users WHERE LOWER(email) = $1)
      RETURNING id, full_name, is_admin`,
    [email]
  )
  if (!rows.length) {
    console.error(`No user found with email "${email}". Sign up first, then re-run.`)
    process.exit(1)
  }
  console.log(`✓ ${email} is now an admin (profile ${rows[0].id}).`)
  console.log('  They will see "Map Admin" in the header after a refresh.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}
