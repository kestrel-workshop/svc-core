// Catálogo de materias para clasificar: id, título, grupo (área) y temas de cada materia, leído del KV
// (subject_JSON) y cacheado en memoria unos minutos. Sirve para que la IA clasificadora vea QUÉ tiene cada
// materia (antes solo veía los ids) y para detectar temas ya existentes en cualquier materia.
// Si algo falla, cargarCatalogo() devuelve null y todo el flujo cae en el comportamiento anterior (solo ids).
import { leerJSON, keyMaterias, keyMateria } from "./kv.js";
import { slugify } from "./slugify.js";
import { readSubject, findSlug } from "./pages.js";
import { llamarIA } from "./iaLigera.js";
import { tokenize } from "./tokens.js";
import { lookupSubjects } from "./wordIndex.js";
export { tokenize };

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // idioma -> { t, data }

async function enLotes(items, tam, fn) {
  const salida = [];
  for (let i = 0; i < items.length; i += tam) {
    salida.push(...(await Promise.all(items.slice(i, i + tam).map(fn))));
  }
  return salida;
}

async function cargarCatalogoCompleto(idioma = "es") {
  const hit = cache.get(idioma);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.data;
  try {
    const indice = await leerJSON(keyMaterias(idioma));
    const lista = Array.isArray(indice?.materias) ? indice.materias.filter((m) => m?.id) : [];
    if (!lista.length) return null;
    const materias = await enLotes(lista, 8, async (m) => {
      let temas = [];
      try {
        const d = await readSubject(m.id, idioma);
        temas = Array.isArray(d?.temas) ? d.temas.filter((t) => t?.titulo) : [];
      } catch (err) {
        console.warn(`[catalogo] no pude leer los temas de ${m.id} (${err.message})`);
      }
      return { id: m.id, titulo: m.titulo || m.id, grupo: m.grupo || "", temas: temas.map((t) => ({ id: t.id || slugify(t.titulo), titulo: t.titulo, nivel: Number.isInteger(t.nivel) ? t.nivel : null })) };
    });
    const grupos = [...new Set(materias.map((m) => m.grupo).filter(Boolean))];
    const data = { materias, grupos, ids: materias.map((m) => m.id) };
    cache.set(idioma, { t: Date.now(), data });
    return data;
  } catch (err) {
    console.warn(`[catalogo] no se pudo armar el catálogo (${err.message}); sigo solo con ids`);
    return null;
  }
}

export function invalidarCatalogo(idioma) {
  if (idioma) { cache.delete(idioma); indexCache.delete(idioma); } else { cache.clear(); indexCache.clear(); }
}

// ¿Ya existe un tema con exactamente este nombre (por slug) en alguna materia? -> { materia, tema } o null
export function buscarTemaEnCatalogo(catalogo, termino) {
  if (!catalogo || !termino) return null;
  const s = slugify(String(termino).trim());
  if (!s) return null;
  for (const m of catalogo.materias) {
    for (const t of m.temas) if (t.id === s || slugify(t.titulo) === s) return { materia: m.id, tema: t.titulo };
  }
  return null;
}

const FULL_MAX = Number(process.env.CATALOG_FULL_MAX) || 60;
const PROMPT_SUBJECTS = Number(process.env.CATALOG_PROMPT_SUBJECTS) || 60;
const MAX_GROUPS_CHOSEN = 3;
const EXTRA_FROM_INDEX = 15;
const indexCache = new Map();
const topicsCache = new Map();

async function loadIndex(language) {
  const hit = indexCache.get(language);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.data;
  const index = await leerJSON(keyMaterias(language));
  const list = Array.isArray(index?.materias) ? index.materias.filter((m) => m?.id) : [];
  if (!list.length) return null;
  const materias = list.map((m) => ({ id: m.id, titulo: m.titulo || m.id, grupo: m.grupo || "" }));
  const data = { materias, grupos: [...new Set(materias.map((m) => m.grupo).filter(Boolean))], ids: materias.map((m) => m.id) };
  indexCache.set(language, { t: Date.now(), data });
  return data;
}

export function scoreSubject(termTokens, subject) {
  const own = tokenize(`${subject.titulo} ${subject.id.replace(/[_-]+/g, " ")}`);
  let score = 0;
  for (const t of termTokens) if (own.has(t)) score += 1;
  return score;
}

async function pickGroups(term, index, language) {
  const examples = new Map();
  for (const m of index.materias) {
    if (!m.grupo) continue;
    const list = examples.get(m.grupo) || [];
    if (list.length < 5) list.push(m.titulo);
    examples.set(m.grupo, list);
  }
  const lines = [...examples.entries()].map(([group, list]) => `- ${group} (e.g. ${list.join("; ")})`).join("\n");
  try {
    const result = await llamarIA({
      system: 'You route a search term to the groups of subjects where it most likely belongs. Output only JSON: {"groups": ["exact group name", ...]} with at most 3 names copied exactly from the list.',
      prompt: `Language: ${language}\nGroups:\n${lines}\n\nTerm: "${term}"`,
      model: "ministral-3b-2512",
      parseJson: true,
      maxTokens: 200,
    });
    const chosen = (Array.isArray(result?.groups) ? result.groups : []).filter((g) => examples.has(g)).slice(0, MAX_GROUPS_CHOSEN);
    if (chosen.length) return new Set(chosen);
  } catch (err) {
    console.warn(`[catalogo] could not pick groups (${err.message})`);
  }
  return null;
}

async function loadTopics(subject, language) {
  const cacheKey = `${language}:${subject.id}`;
  const hit = topicsCache.get(cacheKey);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.topics;
  let topics = [];
  try {
    const data = await readSubject(subject.id, language);
    topics = (Array.isArray(data?.temas) ? data.temas : [])
      .filter((t) => t?.titulo)
      .slice(0, 15)
      .map((t) => ({ id: t.id || slugify(t.titulo), titulo: t.titulo, nivel: Number.isInteger(t.nivel) ? t.nivel : null }));
  } catch (err) {
    console.warn(`[catalogo] could not read the topics of ${subject.id} (${err.message})`);
  }
  topicsCache.set(cacheKey, { t: Date.now(), topics });
  return topics;
}

async function cargarCatalogoReducido(index, term, language) {
  const chosen = await pickGroups(term, index, language);
  const termTokens = tokenize(term);
  let hits = new Map();
  try {
    hits = await lookupSubjects(language, termTokens);
  } catch (err) {
    console.warn(`[catalogo] word index unavailable (${err.message})`);
  }
  const rank = (m) => scoreSubject(termTokens, m) + 3 * (hits.get(m.id) || 0);
  const scored = index.materias.map((m) => ({ m, s: rank(m), inGroup: !chosen || chosen.has(m.grupo) }));
  const fromGroups = scored.filter((x) => x.inGroup).sort((a, b) => b.s - a.s).slice(0, PROMPT_SUBJECTS);
  const fromIndex = scored.filter((x) => !x.inGroup && hits.has(x.m.id)).sort((a, b) => b.s - a.s).slice(0, EXTRA_FROM_INDEX);
  const pool = [...fromIndex, ...fromGroups].sort((a, b) => b.s - a.s).slice(0, PROMPT_SUBJECTS).map((x) => x.m);
  const materias = await enLotes(pool, 8, async (m) => ({ ...m, temas: await loadTopics(m, language) }));
  return { materias, grupos: index.grupos, ids: index.ids, reducido: true };
}

export async function cargarCatalogo(idioma = "es", termino = null) {
  if (!termino) return cargarCatalogoCompleto(idioma);
  try {
    const index = await loadIndex(idioma);
    if (!index) return null;
    if (index.materias.length <= FULL_MAX) return cargarCatalogoCompleto(idioma);
    return await cargarCatalogoReducido(index, termino, idioma);
  } catch (err) {
    console.warn(`[catalogo] could not build the reduced catalog (${err.message}); falling back to the full one`);
    return cargarCatalogoCompleto(idioma);
  }
}

export async function buscarTemaExistente(catalogo, termino, idioma) {
  const local = buscarTemaEnCatalogo(catalogo, termino);
  if (local || !catalogo?.reducido) return local;
  const slug = slugify(String(termino || "").trim());
  if (!slug) return null;
  const subject = await findSlug(idioma, slug);
  return subject ? { materia: subject, tema: String(termino).trim() } : null;
}
