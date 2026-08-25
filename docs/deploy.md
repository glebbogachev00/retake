# Deploying the landing page

The page is one static folder — `site/` — with no build step. Vercel serves
it as-is; the domain is bought at Namecheap and pointed here.

Everything in the page is relative except the social-card URLs, which have
to be absolute because a scraper cannot resolve a relative `og:image`.

## 1. Stamp the domain

```bash
node scripts/site-domain.mjs retake.dev      # your domain, no https://
```

It rewrites the four absolute URLs (`og:url`, `og:image`, `twitter:image`,
`canonical`) and tells you if the placeholder is still there. Re-runnable —
run it again if the domain ever changes. Commit the result.

## 2. Deploy

`vercel.json` at the repo root already says what this is: no install, no
build, serve `site/`. A default import needs no settings.

It has to say so because this repo is two things at once — an npm package
and a landing page. Left to itself Vercel does the reasonable thing for the
package: `npm install` (which runs the testreel patch), then `tsc`, then it
looks for a `public/` directory that was never going to be there. The three
lines that prevent all of it are `installCommand`, `buildCommand` and
`outputDirectory`. Note that Vercel's schema rejects unknown keys, so the
file cannot carry a `//` comment — that is what this paragraph is for.

**From the dashboard** — import `glebbogachev00/retake` on vercel.com and
press Deploy. Leave every setting alone: root directory `./`, framework
"Other", build and install commands untouched. The config overrides them.

**From the terminal**

```bash
npx vercel            # preview build, prints a URL
npx vercel --prod     # production
```

Run it from the repo root, not from `site/`.

If a build ever fails with *No Output Directory named "public"*, Vercel is
ignoring `vercel.json` — usually because the project's Root Directory was
set to something other than `./` in the dashboard. Set it back to `./`.

The config also sets the headers: a year of immutable caching on `/media/*`
(the videos never change under the same name), a week on the logos and the
share image, plus `nosniff`, `SAMEORIGIN` and a referrer policy.

## 3. Point the Namecheap domain at it

In Vercel: **Project → Settings → Domains → Add**, enter the domain. Vercel
then shows the exact records — they are the ones below, but trust Vercel's
screen if it disagrees, because its apex IP does change.

In Namecheap: **Domain List → Manage → Advanced DNS**, delete the parking
records ("CNAME Record @ → parkingpage.namecheap.com" and any URL redirect),
then add:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `@` | `76.76.21.21` | Automatic |
| CNAME Record | `www` | `cname.vercel-dns.com.` | Automatic |

Namecheap writes `@` as the apex. Do not add both an A and a CNAME on `@` —
a CNAME at the apex is invalid and Namecheap will accept it silently.

Propagation is usually minutes. Check it from outside your own DNS cache:

```bash
dig +short retake.dev @1.1.1.1
curl -sI https://retake.dev | head -3
```

Vercel issues the certificate automatically once the records resolve. Pick
one of `retake.dev` / `www.retake.dev` as primary in the Domains screen and
let Vercel redirect the other.

## 4. Check what a stranger gets

```bash
curl -sI https://retake.dev/media/capture-two-places.mp4 | grep -i 'content-type\|content-length'
curl -s https://retake.dev | grep -o 'og:image[^>]*'
```

- The video plays and is `video/mp4`.
- Paste the URL into X, Slack or iMessage: the card shows `og.png`, the
  title, and the description. If the card is blank, the domain was not
  stamped (step 1) — the scrapers cache, so use X's card validator or add
  `?v=2` to force a refetch.
- The tab shows the Retake mark.

## What is NOT deployed, and why

**There is no hosted "try it".** Retake drives a real browser against an app
on your machine and writes files to your disk; a hosted sandbox could not do
the thing the product does, and a fake one would be worse than none. The
page's "try it" is the setup prompt you paste into your own agent — that is
the shortest honest path from the page to a recorded demo.

The npm package (`retake-demos`) is the product; this page is only how
people find it.

## Keeping the media honest

`site/media/` is committed (~4 MB) because the deploy needs it, and its
contents are published cuts only — never raw takes. When a demo is
re-recorded, copy the new `demo.mp4` and its poster in, and the immutable
cache header means you should change the file name or the page will keep
serving the old one to anyone who has visited before.

## Only `main` deploys

`vercel.json` disables deployments for the working branches:

```json
"git": { "deploymentEnabled": { "canvas": false, "chat": false, "operator": false } }
```

Without it every commit pushed to three branches is three deployments, and
a busy day runs into Vercel's daily cap — after which pushes land on GitHub
and the site silently stops updating, with nothing broken to find. That
happened on 2026-08-25: 25 commits, ~75 deploy events, deploys stopped at
18:28 and the last four hours of work never reached the site.

If the site stops updating, check that before checking the code: compare a
file you changed (`curl -s https://<domain>/releases.json`) against the
local one. If the deployment is old rather than the CDN being stale, it is
a deploy that never ran.

## Cutting a release

npm and GitHub should move together, or the public surfaces disagree about
what shipped. When `npm publish` goes out:

```bash
git tag -a v<version> <commit> -m "<one line>"
git push origin --tags
gh release create v<version> --title "<version> — <headline>" --notes-file <body> --latest
```

The body comes from `site/releases.json` — the same words the landing page
and the Retake window show, so a person reads one description of a release
wherever they meet it. Tags matter beyond the release page: without them
nothing in git records what a published version actually was, and an issue
filed against an old version cannot be reproduced.
