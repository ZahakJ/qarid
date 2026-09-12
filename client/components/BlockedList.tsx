/**
 * «المحظورون» — the reader's own block list, on their own profile page
 * (Track 3). It is the one place a block is undone: each row is an account you
 * blocked, with «ألغِ الحظر». Private by construction — this list is served only
 * to the reader it belongs to (`GET /api/block`, per-cookie, no-store).
 */
import { useEffect, useState } from "react"

import { ApiError } from "../api/client.ts"
import { getBlocks, unblockUser } from "../api/queries.ts"
import { routeHash } from "../router.ts"
import { toast } from "../store/toastStore.ts"
import type { BlockedUser } from "../../shared/schema.ts"
import { Avatar } from "./Avatar.tsx"
import { Panel } from "./Panel.tsx"

export function BlockedList() {
  const [blocks, setBlocks] = useState<BlockedUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    getBlocks({ signal: ac.signal })
      .then((res) => {
        if (!ac.signal.aborted) setBlocks(res.blocks)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e.message : "تعذّر جلب القائمة")
      })
    return () => ac.abort()
  }, [])

  const unblock = async (username: string) => {
    if (busy) return
    setBusy(username)
    try {
      const res = await unblockUser(username)
      setBlocks(res.blocks)
      toast("رفعتَ الحظر", "ok")
    } catch (e: unknown) {
      toast(e instanceof ApiError ? e.message : "تعذّر رفع الحظر", "danger")
    } finally {
      setBusy(null)
    }
  }

  if (error) {
    return (
      <Panel quiet className="profile-empty">
        <p className="profile-empty__line" role="alert">
          {error}
        </p>
      </Panel>
    )
  }

  if (blocks === null) {
    return (
      <div className="blocked-list" aria-hidden="true">
        {[0, 1].map((i) => (
          <span className="skeleton" key={i} style={{ blockSize: "3.2rem" }} />
        ))}
      </div>
    )
  }

  if (blocks.length === 0) {
    return (
      <Panel quiet className="profile-empty">
        <div className="profile-empty__text">
          <p className="profile-empty__line">لم تحظر أحدًا.</p>
          <p className="profile-empty__note">من حظرتَه لن يدخل غرفك ولا يساجلك، ولن يعلم بذلك.</p>
        </div>
      </Panel>
    )
  }

  return (
    <ul className="blocked-list">
      {blocks.map((b) => (
        <li className="blocked-row" key={b.username}>
          <a className="blocked-row__who" href={routeHash({ view: "profile", username: b.username })}>
            <span className="blocked-row__disc" aria-hidden="true">
              <Avatar name={b.displayName} src={b.avatar} initialClassName="blocked-row__initial" />
            </span>
            <span className="blocked-row__names">
              <span className="blocked-row__name">{b.displayName}</span>
              <span className="blocked-row__handle">{b.username}</span>
            </span>
          </a>
          <button
            type="button"
            className="btn btn--ghost blocked-row__unblock"
            onClick={() => void unblock(b.username)}
            disabled={busy === b.username}
          >
            ألغِ الحظر
          </button>
        </li>
      ))}
    </ul>
  )
}
