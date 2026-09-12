<div dir="rtl">

# خارطة الشرح — معنى البيت، آليًّا

**مؤجَّل بقرار المالك (2026-08-26): يُضاف بعد أن يستقرَّ إطلاق المتجر.** الفكرة أن
يجد القارئ، تحت كلِّ بيتٍ أو قصيدة، زرَّ «اشرح» يكشف: غريبَ الألفاظ مُفسَّرًا،
ومعنى البيت بعربيّةٍ سهلة، وترجمةً إنجليزية، وإشارةً بلاغيةً عند اللزوم — مع
وسمٍ صريح «شرحٌ آليّ — قد يخطئ»، فلا يُقدَّم ظنٌّ على أنه علم.

</div>

## Why an LLM, not a corpus

`arbml/ashaar` is verse only — no شرح, no glosses, no translations — and no
machine-readable شرح exists that covers 6,941 poets / 3.37M verses. Scraping
partial شروح off aldiwan/adab is patchy and legally murky. So the meaning is
**generated**, the way the sibling `kalam` project reasons over a classical
corpus: an LLM (Claude API) produces, per بيت (or قصيدة):

- **الغريب** — a gloss for each hard/archaic word.
- **المعنى** — a plain-Arabic paraphrase.
- **English** — a faithful (not word-for-word) translation.
- **البلاغة** — optional note on a device actually present (طباق, استعارة, …).

## Why it is light

The weight people fear (a bundled model, multi-GB) never happens. On the app it
is a **button, a text panel, and one network call** — nothing more. The heaviness
is purely operational and is bounded:

- **Cache forever, per verse.** The verse never changes, so each بيت is generated
  **once** and is instant thereafter. A new `sharh` cache table (keyed by the
  normalized bait id via `shared/arabic.ts`) in the writable users db — the
  corpus artefact stays `readOnly`.
- **Only viewed verses cost anything**, once each. **Pre-warm the famous poems**
  (fame ≥ 2) at deploy so the common case feels native and offline-ready.
- **Rate-limited** on the game/read bucket; the response is validated JSON
  (schema in `shared/schema.ts`) so a bad generation is retried, not shown.

## Shape (when built)

- Server: `GET /api/sharh/:baitId` → cache hit returns instantly; miss calls the
  Claude API (see the `claude-api` skill for the current model + call shape —
  **load it before writing any of this**), validates, stores, returns. Pick a
  cheap model for glossing, a stronger one only if quality demands. Never put a
  key in a log/URL.
- Client: an «اشرح» affordance on `BaytPlate` and the poem page → a panel with
  the four sections and the «شرحٌ آليّ — قد يخطئ» label; on-theme, §8 bar.
- Native: the panel loads against the API base like every other call.

## Open decisions the owner deferred

1. **Coverage:** on-demand for *any* poem (richest, live API calls) **vs.**
   pre-generate the famous canon only (fixed, predictable one-time cost, fully
   offline). A hybrid is natural: pre-generate fame ≥ 2, fall back to on-demand
   for the rest if/when on-demand is enabled.
2. **Cost sign-off:** a Claude API key + a bounded per-call spend. This is the
   money fork that parked the feature; it needs the owner's go-ahead.
3. **Audio recitation** was considered alongside and deferred — Arabic classical
   TTS that respects the بحر is hard to do well; revisit separately.
