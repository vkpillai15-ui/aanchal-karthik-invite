# Karthik & Aanchal — wedding invite

A scroll-through cinematic invitation hosted on Netlify.

- `site/` — the invite (`index.html`), videos (`v/`), music (`a/`), stills (`p/`), monogram (`i/`) and the private dashboard (`admin.html`).
- `netlify/functions/api.mjs` — shared state: blessings counter, quiz stats, wish lanterns, dashboard. Stored in Netlify Blobs.

## Settings in Netlify
- Build: nothing to set — `netlify.toml` already says publish `site`, functions `netlify/functions`.
- Environment variable `ADMIN_KEY`: any long secret phrase. It unlocks `/admin.html`.

## Guest links
`https://<your-domain>/?to=Sharma-Family` opens with “Dear Sharma Family,”. Make them on `/admin.html`.
