/**
 * #/favorites?collection= — المختارات (design-ux.md §3, §6).
 *
 * Everything on this page is DENORMALIZED into `qarid:v1:favorites`: a saved
 * بيت carries its own صدر / عجز / شاعر / بحر, so this view renders with the
 * server down, survives a corpus rebuild that renumbers `baits.id`, and never
 * makes a single request. That is the whole point of `SavedBaitSchema`, and it
 * is why the only network-dependent thing here — the link into the قصيدة — is
 * rendered only when a `poemId` was captured at save time.
 *
 * `baytKey` (`${publicPoemId}:${position}`) is the identity throughout, never
 * `baitId`, which is a build-local rowid.
 */
import { useState } from "react"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { Chip } from "../components/Chip.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { baitsOf, useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { navigate, routeHash } from "../router.ts"
import { formatCount } from "../../shared/format.ts"
import type { SavedBait } from "../../shared/schema.ts"

export function FavoritesView({ collection }: { collection?: string }) {
  const settings = useSettings()
  // Two selectors, not one object literal: a selector that builds a fresh
  // object every call re-renders forever under zustand v5's snapshot check.
  const favorites = useCollections((s) => s.favorites)
  const collections = useCollections((s) => s.collections)
  const remove = useCollections((s) => s.remove)
  const createCollection = useCollections((s) => s.createCollection)
  const deleteCollection = useCollections((s) => s.deleteCollection)
  const toggleIn = useCollections((s) => s.toggleIn)

  const [newName, setNewName] = useState("")

  const active = collection && collections.some((c) => c.id === collection) ? collection : undefined
  const shown = baitsOf({ favorites, collections }, active)
  const activeCollection = collections.find((c) => c.id === active)

  const go = (id?: string) => navigate(id ? { view: "favorites", collection: id } : { view: "favorites" })

  return (
    <div className="view fav-view">
      <header className="view__head">
        <h1 className="view__title">المختارات</h1>
        <p className="view__lede">
          ما اخترتَه من الأبيات محفوظ في متصفّحك وحده — بنصّه كاملًا، فيُقرأ ولو انقطع الاتصال.
        </p>
      </header>

      <div className="fav-bar">
        <a
          className="fav-tab"
          href={routeHash({ view: "favorites" })}
          aria-current={active ? undefined : "page"}
          onClick={(e) => {
            e.preventDefault()
            go(undefined)
          }}
        >
          الكل
          <span className="fav-tab__n">{formatCount(favorites.length)}</span>
        </a>
        {collections.map((c) => (
          <a
            className="fav-tab"
            key={c.id}
            href={routeHash({ view: "favorites", collection: c.id })}
            aria-current={active === c.id ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault()
              go(c.id)
            }}
          >
            <bdi>{c.name}</bdi>
            <span className="fav-tab__n">{formatCount(c.baytKeys.length)}</span>
          </a>
        ))}

        <form
          className="fav-new"
          onSubmit={(e) => {
            e.preventDefault()
            const made = createCollection(newName)
            if (made) {
              setNewName("")
              toast(`أُنشئت مجموعة «${made.name}»`, "ok")
              go(made.id)
            }
          }}
        >
          <input
            className="fav-new__input"
            dir="rtl"
            lang="ar"
            /* same set as the omnibox and the duel field: iOS otherwise
               autocapitalises and red-underlines an Arabic collection name */
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={newName}
            placeholder="مجموعة جديدة"
            aria-label="اسم المجموعة الجديدة"
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className="btn btn--ghost" disabled={!newName.trim()}>
            أضِف
          </button>
        </form>
      </div>

      {activeCollection ? (
        <div className="poet-toolbar">
          <span className="fav-note">
            مجموعة «<bdi>{activeCollection.name}</bdi>» — {formatCount(activeCollection.baytKeys.length)} بيتًا
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              deleteCollection(activeCollection.id)
              toast("حُذفت المجموعة (الأبيات باقية في الكل)", "info")
              go(undefined)
            }}
          >
            احذف المجموعة
          </button>
        </div>
      ) : null}

      {shown.length === 0 ? (
        /* An empty COLLECTION is not an empty ديوان: the reader already has
         * أبيات, they just have not filed any here yet — so the way out is «الكل»
         * and the collection chip on a row, not «اضغط ♥ على أيّ بيت». */
        <EmptyState flavor="no-favorites" title={active ? "لا شيء في هذه المجموعة بعد" : undefined}>
          {active && favorites.length > 0 ? (
            <>
              <p className="fav-note">
                افتح «الكل» واضغط «<bdi>{activeCollection?.name}</bdi>» تحت أيّ بيت لتضمّه إلى هذه المجموعة.
              </p>
              <button type="button" className="btn" onClick={() => go(undefined)}>
                إلى الكل
              </button>
            </>
          ) : (
            <>
              <p className="fav-note">اضغط ♥ على أيّ بيت — في القصيدة، أو في البحث، أو في بيت اليوم.</p>
              <a className="btn" href={routeHash({ view: "browse", query: {} })}>
                إلى التصفح
              </a>
            </>
          )}
        </EmptyState>
      ) : (
        <div className="bayt-list" data-bayt-list="">
          {shown.map((f) => (
            <SavedRow
              key={f.baytKey}
              bait={f}
              collections={collections}
              tashkeel={settings.tashkeel}
              showRawiyy={settings.showRawiyy}
              size={settings.verseSize}
              onRemove={() => {
                remove(f.baytKey)
                toast("أُزيل من المختارات", "info")
              }}
              onToggleIn={(id) => toggleIn(id, f.baytKey)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SavedRow({
  bait,
  collections,
  tashkeel,
  showRawiyy,
  size,
  onRemove,
  onToggleIn,
}: {
  bait: SavedBait
  collections: { id: string; name: string; baytKeys: string[] }[]
  tashkeel: boolean
  showRawiyy: boolean
  size: "sm" | "md" | "lg"
  onRemove: () => void
  onToggleIn: (id: string) => void
}) {
  // A بيت saved before the corpus was rebuilt may have no قصيدة to return to.
  const poemHref = bait.poemId ? routeHash({ view: "poem", id: bait.poemId }) : null
  return (
    <article className="bcard">
      <BaytPlate
        variant="row"
        size={size}
        sadr={bait.sadr}
        ajuz={bait.ajuz}
        // The روي is not persisted (SavedBaitSchema keeps text, not derivation);
        // the underline is a poem-page affordance and is simply absent here.
        rawiyy={null}
        showRawiyy={showRawiyy}
        tashkeel={tashkeel}
        favorite
        onFavorite={onRemove}
        label={`بيت ${bait.poet?.name ?? ""}`}
      />
      <div className="bcard__meta">
        {bait.poet ? (
          <a className="bcard__poet" href={routeHash({ view: "poet", slug: bait.poet.slug })}>
            <bdi>{bait.poet.name}</bdi>
          </a>
        ) : (
          <span className="bcard__poet">بلا نسبة</span>
        )}
        {bait.meter ? <Chip variant="bahr" slug={bait.meter.slug} label={bait.meter.name} /> : null}
        {/* A CONTROL, not a fact. These are the same pill shape as the بحر chip
            beside them and were told apart only by a gold ring; the label and
            the dashed rest-state say which of the two a reader is looking at. */}
        {collections.length > 0 ? (
          <span className="fav-chips" role="group" aria-label="المجموعات">
            <span className="fav-chips__label">في</span>
            {collections.map((c) => (
              <Chip
                key={c.id}
                variant="gharad"
                label={c.name}
                active={c.baytKeys.includes(bait.baytKey)}
                onClick={() => onToggleIn(c.id)}
              />
            ))}
          </span>
        ) : null}
        {poemHref ? (
          <a className="bcard__go" href={poemHref}>
            القصيدة ←
          </a>
        ) : null}
        {/* the ♥ on the plate is hover-only (bayt.css), so on a touch device it
            was the ONLY way out of المختارات and it was invisible */}
        <button type="button" className="fav-remove" onClick={onRemove} aria-label="أزِل من المختارات">
          أزِل
        </button>
      </div>
    </article>
  )
}
