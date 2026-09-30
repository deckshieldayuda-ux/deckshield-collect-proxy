import crypto from "crypto";
import { supabase } from "./_lib/supabase.js";

/* =========================
   Shopify App Proxy Verify
   (mismo patron que Torneos: proxy.js de "App Torneos - pruebas")
========================= */
function verifyShopifyProxy(query) {
  const { signature, ...rest } = query;
  if (!signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("");

  const generatedSignature = crypto
    .createHmac("sha256", process.env.SHOPIFY_APP_PROXY_SECRET)
    .update(message)
    .digest("hex");

  return generatedSignature === signature;
}

const VALID_TIERS = ["main", "full", "master", "grand"];
const VALID_FILTERS = ["all", "pending", "done"];

function cleanTier(v) {
  return VALID_TIERS.includes(v) ? v : "master";
}
function cleanFilter(v) {
  return VALID_FILTERS.includes(v) ? v : "all";
}

/* =========================
   Acciones de LECTURA — publicas, no piden customerId
   (decision del usuario: cualquiera puede ver el checklist real
   funcionando; solo marcar una carta pide sesion)
========================= */

async function listExpansions(customerId, q) {
  const tier = cleanTier(q.tier);

  // Antes esto llamaba get_expansion_checklist() COMPLETO 5 veces (arma
  // el jsonb de todas las cartas) solo para sacar 4 numeros por expansion.
  // get_expansions_summary agrega todo del lado de Postgres en una sola
  // llamada, sin serializar ni una carta -- mismo resultado, mucho mas liviano.
  const [{ data: expansions, error }, { data: summaries, error: sumErr }] = await Promise.all([
    supabase
      .from("expansions")
      .select("id, slug, name, logo_url, printed_total, status, series_id")
      .order("id"),
    supabase.rpc("get_expansions_summary", { p_tier: tier, p_customer_id: customerId || null }),
  ]);
  if (error) return { ok: false, error: error.message };
  if (sumErr) return { ok: false, error: sumErr.message };

  const summaryBySlug = new Map((summaries || []).map((s) => [s.expansion_slug, s]));

  const rows = expansions.map((exp) => {
    const s = summaryBySlug.get(exp.slug);
    return {
      slug: exp.slug,
      name: exp.name,
      logo_url: exp.logo_url,
      printed_total: exp.printed_total,
      status: exp.status,
      total: s ? s.total : 0,
      collected: s ? s.collected : 0,
      value_clp: s ? Number(s.value_clp) : 0,
      value_usd: s ? Number(s.value_usd) : 0,
      // Aporte SOLO de las copias extra (mas alla de la 1ra) de cada
      // carta marcada -- value_clp/value_usd de arriba nunca las incluye,
      // asi que el numero "de siempre" no cambia por tener duplicados.
      value_clp_dup: s ? Number(s.value_clp_dup) : 0,
      value_usd_dup: s ? Number(s.value_usd_dup) : 0,
    };
  });

  return { ok: true, tier, expansions: rows };
}

async function getChecklist(customerId, q) {
  const tier = cleanTier(q.tier);
  const filter = cleanFilter(q.filter);
  const sort = q.sort || "number";

  if (!q.expansion) return { ok: false, error: "Falta el parametro 'expansion'." };

  const { data, error } = await supabase.rpc("get_expansion_checklist", {
    p_expansion_slug: q.expansion,
    p_tier: tier,
    p_customer_id: customerId || null,
  });
  if (error) return { ok: false, error: error.message };
  if (data.error) return { ok: false, error: data.error };

  // Politica: nunca mostrar una carta sin imagen real de las APIs, ni una
  // que no tenga precio en TCGplayer (= todavia no esta en el mercado) --
  // red de seguridad ademas de la limpieza hecha en la base. El cron diario
  // (actualizar_precios_diario.py) recorre TODAS las variantes existentes
  // cada dia, asi que apenas tcgcsv le ponga precio a una de estas, entra
  // sola sin tocar nada mas.
  let cards = (data.cards || []).filter((c) => c.image_url && c.price_usd !== null && c.price_usd !== undefined);

  if (q.search) {
    const s = q.search.toLowerCase();
    cards = cards.filter(
      (c) => c.name.toLowerCase().includes(s) || c.number.toLowerCase().includes(s) || (c.artist || "").toLowerCase().includes(s)
    );
  }

  if (filter === "pending") cards = cards.filter((c) => !c.collected);
  if (filter === "done") cards = cards.filter((c) => c.collected);

  // Las cartas sin precio (null/undefined) siempre van al final,
  // sin importar la direccion del ordenamiento -- si no, el (x || 0)
  // las trataba como precio 0 y las mezclaba al principio del orden desc.
  const priceCmp = (a, b, dir) => {
    const pa = a.price_clp, pb = b.price_clp;
    const aNull = pa === null || pa === undefined;
    const bNull = pb === null || pb === undefined;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return dir * (pa - pb);
  };
  // "Recientes" primero, sin fecha al final -- igual regla de null-al-final
  // que priceCmp.
  const recentCmp = (a, b) => {
    const da = a.collected_at, db = b.collected_at;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return new Date(db) - new Date(da);
  };
  const sorters = {
    number: (a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }),
    name: (a, b) => a.name.localeCompare(b.name),
    price_asc: (a, b) => priceCmp(a, b, 1),
    price_desc: (a, b) => priceCmp(a, b, -1),
    recent: recentCmp,
  };
  cards.sort(sorters[sort] || sorters.number);

  const collected = cards.filter((c) => c.collected);
  return {
    ok: true,
    expansion: q.expansion,
    tier,
    filter,
    sort,
    total: cards.length,
    collected: collected.length,
    cards,
  };
}

async function getCollectionValue(customerId, q) {
  const tier = cleanTier(q.tier);
  const { data, error } = await supabase.rpc("get_collection_value", {
    p_customer_id: customerId || null,
    p_expansion_slug: q.expansion || null,
    p_tier: tier,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, tier, ...data };
}

async function getProfile(customerId) {
  if (!customerId) return { ok: true, logged_in: false, alias: null };
  const { data } = await supabase
    .from("user_profiles")
    .select("alias")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  return { ok: true, logged_in: true, alias: data?.alias || null };
}

async function getPriceHistory(customerId, q) {
  const variantId = Number(q.card_variant_id);
  if (!Number.isFinite(variantId)) return { ok: false, error: "card_variant_id invalido." };
  const { data, error } = await supabase
    .from("card_price_history")
    .select("source, price, recorded_date")
    .eq("card_variant_id", variantId)
    .order("recorded_date", { ascending: true })
    .limit(90);
  if (error) return { ok: false, error: error.message };
  return { ok: true, points: data || [] };
}

/* =========================
   Acciones de ESCRITURA — requieren sesion (logged_in_customer_id)
========================= */

async function toggleOwned(customerId, q) {
  const variantId = Number(q.card_variant_id);
  if (!Number.isFinite(variantId)) return { ok: false, error: "card_variant_id invalido." };

  const { data: existing } = await supabase
    .from("user_owned")
    .select("id")
    .eq("shopify_customer_id", customerId)
    .eq("card_variant_id", variantId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase.from("user_owned").delete().eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, card_variant_id: variantId, collected: false, quantity: 0 };
  } else {
    const { error } = await supabase
      .from("user_owned")
      .insert([{ shopify_customer_id: customerId, card_variant_id: variantId }]);
    if (error) return { ok: false, error: error.message };
    return { ok: true, card_variant_id: variantId, collected: true, quantity: 1 };
  }
}

// Permite tener mas de 1 copia de una misma carta (ej. armar 2 master
// sets) -- incrementa/decrementa user_owned.quantity en vez del
// existe/no-existe binario de toggleOwned. Al llegar a 0 se borra la fila
// (mismo estado final que toggleOwned al desmarcar).
async function incrementOwned(customerId, q) {
  const variantId = Number(q.card_variant_id);
  if (!Number.isFinite(variantId)) return { ok: false, error: "card_variant_id invalido." };

  const { data: existing } = await supabase
    .from("user_owned")
    .select("id, quantity")
    .eq("shopify_customer_id", customerId)
    .eq("card_variant_id", variantId)
    .maybeSingle();

  if (existing) {
    const newQty = existing.quantity + 1;
    const { error } = await supabase.from("user_owned").update({ quantity: newQty }).eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, card_variant_id: variantId, collected: true, quantity: newQty };
  } else {
    const { error } = await supabase
      .from("user_owned")
      .insert([{ shopify_customer_id: customerId, card_variant_id: variantId, quantity: 1 }]);
    if (error) return { ok: false, error: error.message };
    return { ok: true, card_variant_id: variantId, collected: true, quantity: 1 };
  }
}

async function decrementOwned(customerId, q) {
  const variantId = Number(q.card_variant_id);
  if (!Number.isFinite(variantId)) return { ok: false, error: "card_variant_id invalido." };

  const { data: existing } = await supabase
    .from("user_owned")
    .select("id, quantity")
    .eq("shopify_customer_id", customerId)
    .eq("card_variant_id", variantId)
    .maybeSingle();

  if (!existing) return { ok: true, card_variant_id: variantId, collected: false, quantity: 0 };

  if (existing.quantity <= 1) {
    const { error } = await supabase.from("user_owned").delete().eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, card_variant_id: variantId, collected: false, quantity: 0 };
  } else {
    const newQty = existing.quantity - 1;
    const { error } = await supabase.from("user_owned").update({ quantity: newQty }).eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, card_variant_id: variantId, collected: true, quantity: newQty };
  }
}

async function resetExpansion(customerId, q) {
  if (!q.expansion) return { ok: false, error: "Falta el parametro 'expansion'." };
  const { data: exp } = await supabase.from("expansions").select("id").eq("slug", q.expansion).maybeSingle();
  if (!exp) return { ok: false, error: "Expansion no encontrada." };

  const { data: cards } = await supabase.from("cards").select("id").eq("expansion_id", exp.id);
  const cardIds = (cards || []).map((c) => c.id);
  if (!cardIds.length) return { ok: true, deleted: 0 };

  const { data: variants } = await supabase.from("card_variants").select("id").in("card_id", cardIds);
  const variantIds = (variants || []).map((v) => v.id);
  if (!variantIds.length) return { ok: true, deleted: 0 };

  const { error, count } = await supabase
    .from("user_owned")
    .delete({ count: "exact" })
    .eq("shopify_customer_id", customerId)
    .in("card_variant_id", variantIds);
  if (error) return { ok: false, error: error.message };
  return { ok: true, deleted: count || 0 };
}

async function setAlias(customerId, q) {
  const alias = (q.alias || "").toString().trim().slice(0, 40) || null;
  const { error } = await supabase
    .from("user_profiles")
    .upsert(
      { shopify_customer_id: customerId, alias, updated_at: new Date().toISOString() },
      { onConflict: "shopify_customer_id" }
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true, alias };
}

const WRITE_ACTIONS = new Set(["toggle_owned", "increment_owned", "decrement_owned", "set_alias", "reset_expansion"]);

async function runAction(customerId, action, q) {
  switch (action) {
    case "list_expansions":
      return listExpansions(customerId, q);
    case "get_checklist":
      return getChecklist(customerId, q);
    case "get_collection_value":
      return getCollectionValue(customerId, q);
    case "get_profile":
      return getProfile(customerId);
    case "get_price_history":
      return getPriceHistory(customerId, q);
    case "toggle_owned":
      return toggleOwned(customerId, q);
    case "increment_owned":
      return incrementOwned(customerId, q);
    case "decrement_owned":
      return decrementOwned(customerId, q);
    case "set_alias":
      return setAlias(customerId, q);
    case "reset_expansion":
      return resetExpansion(customerId, q);
    default:
      return { ok: false, error: "Accion desconocida" };
  }
}

/* =========================
   Main Handler
========================= */
export default async function handler(req, res) {
  if (!verifyShopifyProxy(req.query)) {
    return res.status(401).json({ ok: false, error: "Invalid Shopify signature" });
  }

  const customerId = req.query.logged_in_customer_id || null;
  const action = req.query.action;

  // A diferencia de Torneos: las acciones de LECTURA son publicas (se puede
  // ver el checklist sin sesion). Solo las de ESCRITURA piden login.
  if (WRITE_ACTIONS.has(action) && !customerId) {
    return res.json({
      ok: false,
      logged_in: false,
      error: "Inicia sesion con tu cuenta de Deck Shield para marcar cartas.",
    });
  }

  const result = await runAction(customerId, action, req.query);
  return res.json(result);
}
