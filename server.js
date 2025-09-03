import express from "express";
import session from "express-session";
import cors from "cors";
import dotenv from "dotenv";
import passport from "./auth.js";
import { supa } from "./supabaseClient.js";
import { ensureReady, lookupItemsAsync, searchItemsWithImages } from "./itemsCache.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(
  cors({
    origin: process.env.FRONTEND_URL, // напр. "http://localhost:5173"
    credentials: true,
  })
);

app.use(express.json());

// Якщо будеш за проксі/HTTPS у проді — розкоментуй:
// app.set("trust proxy", 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax", // локально ок; у проді: 'none' + secure:true
      secure: false,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

/* --------------------- AUTH (Steam only) --------------------- */
app.get("/auth/steam", passport.authenticate("steam", { session: true }));

app.get(
  "/auth/steam/return",
  passport.authenticate("steam", { failureRedirect: `${process.env.FRONTEND_URL}/login` }),
  (req, res) => {
    req.session.save(() => {
      res.redirect(`${process.env.FRONTEND_URL}/profile`);
    });
  }
);

function isActive(until) {
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
}

app.post("/auth/signout", (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.status(200).json({ ok: true });
    });
  });
});

/* --------------------- Current user --------------------- */
app.get("/api/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ user: null });

  const activeNow = isActive(req.user.subscription_until);
  if (req.user.subscription_active !== activeNow) {
    const { data } = await supa
      .from("users")
      .update({ subscription_active: activeNow })
      .eq("id", req.user.id)
      .select("*")
      .single();
    return res.json({ user: data });
  }

  res.json({ user: req.user });
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  next();
}
async function requireSub(req, res, next) {
  const { data, error } = await supa
    .from("users")
    .select("subscription_active, subscription_until")
    .eq("id", req.user.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const ok = !!data.subscription_active && isActive(data.subscription_until);
  if (!ok) return res.status(402).json({ error: "subscription_required" });

  next();
}

/* --------------------- Subscription API --------------------- */
app.get("/api/subscription", requireAuth, async (req, res) => {
  const { data, error } = await supa
    .from("users")
    .select("subscription_active, subscription_until")
    .eq("id", req.user.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/subscription/buy", requireAuth, async (req, res) => {
  const months = Number(req.body?.months || 1);
  const now = new Date();
  const currentUntil = req.user.subscription_until ? new Date(req.user.subscription_until) : null;

  const base = currentUntil && isActive(currentUntil) ? currentUntil : now;
  const newUntil = new Date(base);
  newUntil.setMonth(newUntil.getMonth() + months);

  const { data, error } = await supa
    .from("users")
    .update({
      subscription_until: newUntil.toISOString(),
      subscription_active: true,
    })
    .eq("id", req.user.id)
    .select("subscription_active, subscription_until")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// промокоди (демо): FREE7, FREE30
app.post("/api/subscription/apply", requireAuth, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const days = code === "TEST30" ? 30 : code === "TEST7" ? 7 : 0;
  if (!days) return res.status(400).json({ error: "invalid_code" });

  const now = new Date();
  const currentUntil = req.user.subscription_until ? new Date(req.user.subscription_until) : null;

  const base = currentUntil && isActive(currentUntil) ? currentUntil : now;
  const newUntil = new Date(base);
  newUntil.setDate(newUntil.getDate() + days);

  const { data, error } = await supa
    .from("users")
    .update({
      subscription_until: newUntil.toISOString(),
      subscription_active: true,
    })
    .eq("id", req.user.id)
    .select("subscription_active, subscription_until")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* ======================================================================
   SNAPSHOTS (щоденні знімки портфеля)
   ====================================================================== */

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Обчислює і upsert-ить знімок на сьогодні для портфеля.
 * invested = Σ(buy price*qty) − Σ(sell price*qty)  (клампимо до 0)
 * value    = Σ(current price * net qty, тільки для net qty > 0)
 */
async function upsertTodaySnapshot(userId, portfolioId) {
  const { data: txs, error: txErr } = await supa
    .from("transactions")
    .select("item_name, price, quantity, type, date")
    .eq("portfolio_id", portfolioId);
  if (txErr) throw txErr;

  const qty = new Map(); // name -> net quantity
  let invested = 0;
  for (const t of txs || []) {
    const sign = t.type === "buy" ? 1 : -1;
    invested += sign * Number(t.price) * Number(t.quantity);
    qty.set(t.item_name, (qty.get(t.item_name) || 0) + sign * Number(t.quantity));
  }

  await ensureReady();
  const names = Array.from(qty.entries()).filter(([, q]) => q > 0).map(([name]) => name);
  const dict = names.length ? await lookupItemsAsync(names) : {};

  let value = 0;
  for (const [name, q] of qty.entries()) {
    if (q <= 0) continue;
    const price = dict[name]?.price ?? 0;
    value += q * price;
  }

  const day = new Date().toISOString().slice(0, 10);
  const payload = {
    user_id: userId,
    portfolio_id: portfolioId,
    day,
    invested: round2(Math.max(0, invested)),
    value: round2(value),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supa
    .from("portfolio_snapshots")
    .upsert(payload, { onConflict: "portfolio_id,day" })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/* --------------------- Portfolios (requires subscription) --------------------- */
app.get("/api/portfolios", requireAuth, requireSub, async (req, res) => {
  const { data, error } = await supa
    .from("portfolios")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/portfolios", requireAuth, requireSub, async (req, res) => {
  const name = (req.body?.name || "Portfolio").toString();
  const { data, error } = await supa
    .from("portfolios")
    .insert({ user_id: req.user.id, name })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  try {
    await upsertTodaySnapshot(req.user.id, data.id);
  } catch (_) {}

  res.json(data);
});

app.patch("/api/portfolios/:id", requireAuth, requireSub, async (req, res) => {
  const { id } = req.params;
  const name = (req.body?.name || "Portfolio").toString();

  const { data: owned } = await supa
    .from("portfolios")
    .select("id")
    .eq("id", id)
    .eq("user_id", req.user.id)
    .single();
  if (!owned) return res.status(404).json({ error: "not found" });

  const { data, error } = await supa
    .from("portfolios")
    .update({ name })
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/portfolios/:id", requireAuth, requireSub, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supa
    .from("portfolios")
    .delete()
    .eq("id", id)
    .eq("user_id", req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* --------------------- Transactions (requires subscription) --------------------- */
app.get("/api/portfolios/:id/transactions", requireAuth, requireSub, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supa
    .from("transactions")
    .select("*")
    .eq("portfolio_id", id)
    .order("date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/portfolios/:id/transactions", requireAuth, requireSub, async (req, res) => {
  const { id } = req.params;
  const { item_name, price, quantity, type, date } = req.body;

  const { data: owned } = await supa
    .from("portfolios")
    .select("id")
    .eq("id", id)
    .eq("user_id", req.user.id)
    .single();
  if (!owned) return res.status(404).json({ error: "Portfolio not found" });

  const { data, error } = await supa
    .from("transactions")
    .insert({
      portfolio_id: id,
      item_name,
      price,
      quantity,
      type,
      date: date || new Date().toISOString(),
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  try {
    await upsertTodaySnapshot(req.user.id, id);
  } catch (_) {}

  res.json(data);
});

app.delete("/api/transactions/:txId", requireAuth, requireSub, async (req, res) => {
  const { txId } = req.params;

  const { data: tx, error: txErr } = await supa
    .from("transactions")
    .select("id, portfolio_id")
    .eq("id", txId)
    .limit(1)
    .single();
  if (txErr || !tx) return res.status(404).json({ error: "not found" });

  const { data: port, error: portErr } = await supa
    .from("portfolios")
    .select("user_id")
    .eq("id", tx.portfolio_id)
    .limit(1)
    .single();
  if (portErr || !port || port.user_id !== req.user.id)
    return res.status(404).json({ error: "not found" });

  const { data, error } = await supa
    .from("transactions")
    .delete()
    .eq("id", txId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  try {
    await upsertTodaySnapshot(req.user.id, tx.portfolio_id);
  } catch (_) {}

  res.json(data);
});

/* --------------------- Snapshots API --------------------- */
app.get("/api/portfolios/:id/snapshots", requireAuth, requireSub, async (req, res) => {
  const { id } = req.params;
  const days = Number(req.query.days || 180);

  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - (days - 1));
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  const { data, error } = await supa
    .from("portfolio_snapshots")
    .select("day, invested, value")
    .eq("portfolio_id", id)
    .gte("day", fromStr)
    .lte("day", toStr)
    .order("day", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/api/portfolios/:id/snapshots/today", requireAuth, requireSub, async (req, res) => {
  const { id } = req.params;

  const { data: owned } = await supa
    .from("portfolios")
    .select("id, user_id")
    .eq("id", id)
    .single();
  if (!owned || owned.user_id !== req.user.id) return res.status(404).json({ error: "not found" });

  try {
    const row = await upsertTodaySnapshot(req.user.id, id);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* --------------------- Items API (public) --------------------- */
// Пошук для автокомпліту (повертає також картинку з Steam, якщо треба)
app.get("/api/items/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const list = await searchItemsWithImages(q, 10);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Лукап для таблиць/позицій
app.post("/api/items/lookup", async (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  if (!names.length) return res.json({});
  try {
    const dict = await lookupItemsAsync(names);
    res.json(dict);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* --------------------- Steam Market proxy (optional) --------------------- */
app.get("/api/steam/price", async (req, res) => {
  const { appid = "730", market_hash_name, currency = "1" } = req.query;
  if (!market_hash_name) return res.status(400).json({ error: "market_hash_name required" });
  const url = `https://steamcommunity.com/market/priceoverview/?appid=${appid}&currency=${currency}&market_hash_name=${encodeURIComponent(
    market_hash_name
  )}`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const data = await r.json();
  res.json(data);
});

app.get("/api/steam/history", async (req, res) => {
  const { appid = "730", market_hash_name } = req.query;
  if (!market_hash_name) return res.status(400).json({ error: "market_hash_name required" });
  const url = `https://steamcommunity.com/market/pricehistory/?appid=${appid}&market_hash_name=${encodeURIComponent(
    market_hash_name
  )}`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const data = await r.json();
  res.json(data);
});

/* --------------------- Debug helper --------------------- */
app.get("/debug/session", (req, res) => {
  res.json({ hasUser: !!req.user, user: req.user ?? null, sid: req.sessionID });
});

/* --------------------- Error handler --------------------- */
app.use((err, _req, res, _next) => {
  console.error("UNCAUGHT ERROR:", err);
  res.status(500).send(err?.message || "Internal Server Error");
});

/* --------------------- Daily snapshots job --------------------- */
async function runDailySnapshotsForAll() {
  const { data: ports, error } = await supa.from("portfolios").select("id, user_id");
  if (error || !ports?.length) return;
  for (const p of ports) {
    try {
      await upsertTodaySnapshot(p.user_id, p.id);
    } catch (_) {}
  }
}

let lastJobDay = "";
setInterval(async () => {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastJobDay) return;
  lastJobDay = today;
  try {
    await runDailySnapshotsForAll();
  } catch (_) {}
}, 60 * 60 * 1000); // раз на годину — гарантія 1 раз/добу

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});
