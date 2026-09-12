# FAIRGROUND — submission checklist

Deadline: **Sep 20, 2026, 23:59 UTC** · Target: **submit Sep 16–17**

## ✅ SUBMITTED

- **Entry ID:** `j576k66tcbm28r3qfvfmz234a98e87de` (issued after the automatic URL check passed)
- **Submitted URL:** https://fairground.sithunyein.com
- **Verify any time:** jam.chain.wtf → "Check your entry ID"

## Live URLs

- **Primary (submit this):** https://thesithunyein.github.io/fairground/ — live, public, auto-deploys on every push to `main` (GitHub Actions)
- **Mirror:** https://fairground.sithunyein.com — Vercel, public, connected to the GitHub repo (every push to `main` auto-deploys both URLs)

## Eligibility gates (automated + human)

- [x] Implements the Chain casino SDK exactly — `ICasinoGameV2`, SDK bridge only, validated manifest
- [x] Runs in the local simulator — 3/3 E2E rounds pass on the real VRF node (safe/mid/risky)
- [x] RTP 93–98%, declared = actual — locked at 96% by construction, proven by `verify:rtp` (300/300 classes + Monte-Carlo)
- [x] Recognizably casino, novel — prize wheel + paintable paytable; no classic/clone
- [ ] Standalone demo outside the iframe — built (auto-detects missing host); **verify on the deployed URL before submitting**
- [ ] Jam widget tag present on the live page — in `index.html`; **verify after deploy**

## Before submit (in order)

1. [ ] `npm run build` clean; `dist/` deployed to the live domain (HTTPS)
2. [ ] Open the URL directly: demo mode boots, spin works, prize drops, no console errors
3. [ ] View-source: `widget.js` tag present in the served HTML
4. [ ] Iframe test: load the URL inside a test page ≈800×600 — layout adapts, game playable
5. [ ] Source access ready (public GitHub repo URL)
6. [ ] Discord handle ready (required field)

## Submission form fields (from jam.chain.wtf)

- **Title:** FAIRGROUND
- **Game URL:** the deployed https URL
- **Declared RTP:** 96
- **Discord:** (your handle — required)
- **X / Telegram:** optional
- **Source access:** repo URL (private OK — invite their review account)
- **Pitch (1–2 sentences — this is the gallery card copy):**
  > The honest carnival: a provably uniform prize wheel whose payout table YOU paint —
  > safe, mid or risky — while the contract keeps RTP at exactly 96% however you paint it.
  > Every spin drops a collectible prize; fill sets, unlock liveries.

## After submit

- [x] Entry ID received: `j576k66tcbm28r3qfvfmz234a98e87de`
- [x] Confirmed: FAIRGROUND card live in the gallery with the pitch (position #1, top-left)
- [ ] Launch: 30s clip (record at `/?clean=1`), X thread, Discord post
- [ ] Keep shipping: same URL, newest build counts until Sep 20
- [ ] Distribution: X thread + demo clip, Discord post, friends through the demo
- [ ] Track the engagement board daily (leader baseline: 79 active minutes)
