// Shared state for the invite: the blessings counter, quiz stats and wish lanterns.
// Everything lives in one Netlify Blobs store. Aggregates are updated with
// compare-and-swap (onlyIfMatch) so simultaneous guests never overwrite each other.
import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "invite", consistency: "strong" });
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const QUESTIONS = 11;
const MAX_WISHES = 600;

// Read-modify-write with optimistic concurrency, retried on conflict.
async function update(key, init, fn) {
  const s = store();
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const next = fn(cur ? cur.data : structuredClone(init));
    const res = cur
      ? await s.setJSON(key, next, { onlyIfMatch: cur.etag })
      : await s.setJSON(key, next, { onlyIfNew: true });
    if (res.modified) return next;
    await new Promise(r => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
  }
  throw new Error("busy");
}
async function firstTime(key) {
  const res = await store().setJSON(key, { at: Date.now() }, { onlyIfNew: true });
  return res.modified;
}
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const gid = v => /^[a-z0-9]{8,32}$/.test(String(v)) ? String(v) : null;
const isAdmin = req => {
  const k = process.env.ADMIN_KEY;
  return Boolean(k) && new URL(req.url).searchParams.get("key") === k;
};

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  try {
    // ---------- blessings ----------
    if (route === "blessings" && req.method === "GET") {
      return json((await store().get("bless/total", { type: "json" })) || { count: 0, guests: 0 });
    }
    if (route === "blessings" && req.method === "POST") {
      const body = await req.json();
      const id = gid(body.guest), n = Math.max(0, Math.min(50, Math.floor(Number(body.n) || 0)));
      if (!id || !n) return json({ error: "bad request" }, 400);
      const isNew = await firstTime(`bless/guest/${id}`);
      return json(await update("bless/total", { count: 0, guests: 0 }, t => ({ count: t.count + n, guests: t.guests + (isNew ? 1 : 0) })));
    }

    // ---------- quiz ----------
    if (route === "quiz" && req.method === "GET") {
      return json((await store().get("quiz/agg", { type: "json" })) || { plays: 0, correct: Array(QUESTIONS).fill(0), scores: Array(QUESTIONS + 1).fill(0) });
    }
    if (route === "quiz" && req.method === "POST") {
      const body = await req.json();
      const id = gid(body.guest), right = Array.isArray(body.right) ? body.right.slice(0, QUESTIONS).map(Boolean) : null;
      if (!id || !right || right.length !== QUESTIONS) return json({ error: "bad request" }, 400);
      const empty = { plays: 0, correct: Array(QUESTIONS).fill(0), scores: Array(QUESTIONS + 1).fill(0) };
      if (!(await firstTime(`quiz/guest/${id}`))) return json((await store().get("quiz/agg", { type: "json" })) || empty);
      const score = right.filter(Boolean).length;
      return json(await update("quiz/agg", empty, a => ({
        plays: a.plays + 1, correct: a.correct.map((c, i) => c + (right[i] ? 1 : 0)), scores: a.scores.map((c, i) => c + (i === score ? 1 : 0))
      })));
    }

    // ---------- wishes ----------
    if (route === "wishes" && req.method === "GET") {
      const all = (await store().get("wishes/all", { type: "json" })) || [];
      return json(all.filter(w => !w.hidden).slice(-120).map(({ id, name, wish }) => ({ id, name, wish })));
    }
    if (route === "wishes" && req.method === "POST") {
      const body = await req.json();
      const id = gid(body.guest), name = clean(body.name, 40), wish = clean(body.wish, 140);
      if (!id || !name || wish.length < 2) return json({ error: "Please add your name and a short wish." }, 400);
      const mine = await update(`wishes/guest/${id}`, { n: 0, last: 0 }, g => {
        if (g.n >= 5) throw Object.assign(new Error("limit"), { code: 429 });
        if (Date.now() - g.last < 20000) throw Object.assign(new Error("slow"), { code: 429 });
        return { n: g.n + 1, last: Date.now() };
      });
      const entry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, wish, at: Date.now(), hidden: false, guest: id, sent: mine.n };
      await update("wishes/all", [], all => [...all, entry].slice(-MAX_WISHES));
      return json({ ok: true, id: entry.id });
    }

    // ---------- private dashboard ----------
    if (route === "admin" && req.method === "GET") {
      if (!isAdmin(req)) return json({ error: "Wrong or missing key" }, 401);
      const s = store();
      const [bless, quiz, wishes] = await Promise.all([s.get("bless/total", { type: "json" }), s.get("quiz/agg", { type: "json" }), s.get("wishes/all", { type: "json" })]);
      return json({ bless: bless || { count: 0, guests: 0 }, quiz, wishes: wishes || [] });
    }
    if (route === "admin/hide" && req.method === "POST") {
      if (!isAdmin(req)) return json({ error: "Wrong or missing key" }, 401);
      const { id, hidden } = await req.json();
      await update("wishes/all", [], all => all.map(w => (w.id === id ? { ...w, hidden: Boolean(hidden) } : w)));
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e && e.code === 429) return json({ error: e.message === "limit" ? "You’ve sent five wishes already — thank you!" : "Give it a few seconds before the next wish." }, 429);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config = { path: ["/api/blessings", "/api/quiz", "/api/wishes", "/api/admin", "/api/admin/hide"] };
