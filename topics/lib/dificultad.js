// Dificultad (1 a 5) y temas previos ("requiere") de cada tema. Se guardan en el KV junto a {id, titulo}:
//   { "id": "derivadas", "titulo": "Derivadas", "dificultad": 3, "requiere": ["limites-y-continuidad"] }
// El sitio los usa para el mapa de temas (nivel, conexiones, color por dificultad).
// Si algo falla NUNCA se corta la publicación del tema: simplemente queda sin esos campos.
import { llamarIA as llamarIALigera } from "./iaLigera.js";
import { cargarCatalogo } from "./catalogo.js";
import { armarPromptDificultad } from "../prompts/dificultad.js";
import { slugify } from "./slugify.js";

export const MAX_REQUIERE = 5;
export const MIN_TOPIC_LEVEL = 1;
export const MAX_TOPIC_LEVEL = 7;

export function applyLevelFloor(result, levelsById) {
  if (!result || !Number.isInteger(result.nivel) || !Array.isArray(result.requiere)) return result;
  const floor = result.requiere.reduce((m, id) => Math.max(m, Number(levelsById.get(id)) || 0), 0);
  if (floor > result.nivel) return { ...result, nivel: Math.min(floor, MAX_TOPIC_LEVEL) };
  return result;
}

// Compara ids sin importar espacios, guiones, mayúsculas, signos ni la forma Unicode: en idiomas con escritura propia
// (coreano, japonés, chino, árabe...) los ids son el título en esa escritura y la IA a veces los devuelve con otro
// separador o normalización.
export function claveId(s) {
  return String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s\-_,.;:·、，。()（）[\]"'“”«»]+/g, "");
}

/**
 * Devuelve resolver(x) -> id real del catálogo o null. Acepta el id exacto, el id "alterado" (ver claveId) o el título.
 * temas = [{ id, titulo }] de TODO el catálogo.
 */
export function crearResolver(temas) {
  const ids = new Set(temas.map((t) => t.id));
  const porClave = new Map(), porTitulo = new Map();
  for (const t of temas) {
    if (!porClave.has(claveId(t.id))) porClave.set(claveId(t.id), t.id);
    if (t.titulo && !porTitulo.has(claveId(t.titulo))) porTitulo.set(claveId(t.titulo), t.id);
  }
  return (x) => (ids.has(x) ? x : porClave.get(claveId(x)) || porTitulo.get(claveId(x)) || null);
}

// Proporciones objetivo de cada nivel cuando se evalúa el catálogo entero (nivel 1 a 5).
export const PROPORCIONES = [0.10, 0.25, 0.30, 0.25, 0.10];
// Con menos temas que esto el reparto por ranking no tiene sentido y se usan los umbrales fijos.
export const MIN_TEMAS_REPARTO = 30;

// Puntaje 0-100 -> nivel 1-5 con umbrales fijos (para un tema suelto).
export function nivelPorPuntaje(p) {
  return p < 20 ? 1 : p < 40 ? 2 : p < 60 ? 3 : p < 80 ? 4 : 5;
}

/**
 * Reparte niveles 1-5 según la posición en el ranking de puntajes, respetando `proporciones`.
 * items = [{ id, puntaje }]. Devuelve { id: nivel }. Desempata por id, así es determinista.
 * Sirve cuando se evalúa mucho catálogo junto: la IA tiende a poner todo en el medio, pero el ORDEN que da
 * sí es útil.
 */
export function repartirNiveles(items, proporciones = PROPORCIONES) {
  const orden = [...items].sort((a, b) => a.puntaje - b.puntaje || String(a.id).localeCompare(String(b.id)));
  const n = orden.length;
  const cortes = [];
  let acum = 0;
  for (let i = 0; i < proporciones.length - 1; i++) { acum += proporciones[i]; cortes.push(Math.round(n * acum)); }
  const salida = {};
  orden.forEach((it, i) => { salida[it.id] = 1 + cortes.filter((c) => i >= c).length; });
  return salida;
}

// Deja solo valores válidos: puntaje 0-100 (y su nivel 1-5), requiere = ids que existen, sin repetir ni a sí mismo.
// Si la IA devuelve directamente "dificultad" (1-5) en vez de "puntaje", también se acepta.
export function normalizarDificultad(crudo, idsValidos, idPropio, resolver = null) {
  const salida = {};
  const p = typeof crudo?.puntaje === "string" ? Number(crudo.puntaje) : crudo?.puntaje;
  if (typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 100) {
    salida.puntaje = Math.round(p);
    salida.dificultad = nivelPorPuntaje(p);
  } else {
    const n = Math.round(Number(crudo?.dificultad));
    if (Number.isFinite(n) && n >= 1 && n <= 5) salida.dificultad = n;
  }
  const level = Math.round(Number(crudo?.nivel));
  if (Number.isFinite(level) && level >= MIN_TOPIC_LEVEL && level <= MAX_TOPIC_LEVEL) salida.nivel = level;
  if (Array.isArray(crudo?.requiere)) {
    const vistos = new Set();
    const lista = [];
    for (const r of crudo.requiere) {
      const id = resolver ? (resolver(String(r || "").trim()) || "") : String(r || "").trim();
      if (!id || id === idPropio || vistos.has(id) || !idsValidos.has(id)) continue;
      vistos.add(id);
      lista.push(id);
      if (lista.length >= MAX_REQUIERE) break;
    }
    salida.requiere = lista;
  }
  return salida;
}

// Quita los vínculos que cerrarían un ciclo (A -> B -> A). `mapa` = { id: [requiere...] } ya existente.
export function sinCiclos(idNuevo, requiere, mapa) {
  const llega = (desde, objetivo, visto = new Set()) => {
    if (desde === objetivo) return true;
    if (visto.has(desde)) return false;
    visto.add(desde);
    return (mapa[desde] || []).some((x) => llega(x, objetivo, visto));
  };
  // si algo de lo que requiere ya depende (directa o indirectamente) del tema nuevo, se descarta
  return requiere.filter((r) => !llega(r, idNuevo));
}

function levelsOf(catalogo) {
  return new Map((catalogo?.materias || []).flatMap((m) => m.temas.map((t) => [t.id, t.nivel])));
}
function temasDelCatalogo(catalogo) {
  return (catalogo?.materias || []).flatMap((m) => m.temas.map((t) => ({ id: t.id, titulo: t.titulo })));
}
function idsDelCatalogo(catalogo) {
  return new Set(temasDelCatalogo(catalogo).map((t) => t.id));
}

/**
 * Evalúa UN tema recién creado. Devuelve { dificultad?, requiere? } (puede venir vacío).
 */
export const difficultyDiagnostics = { lastError: null };

export async function calcularDificultadYRequisitos({ tema, materia, idioma = "es" }) {
  difficultyDiagnostics.lastError = null;
  try {
    const catalogo = await cargarCatalogo(idioma, String(tema));
    if (!catalogo) {
      difficultyDiagnostics.lastError = "catalog unavailable";
      return {};
    }
    const id = slugify(String(tema).trim());
    const materiaInfo = catalogo.materias.find((m) => m.id === materia);
    const { system, prompt } = armarPromptDificultad([{ id, titulo: tema, materia: materiaInfo?.titulo || materia }], catalogo, idioma);
    const resp = await llamarIALigera({ system, prompt, model: "claude-sonnet-5-5", parseJson: true, maxTokens: 600 });
    const crudo = resp?.temas?.[id] || (resp?.temas ? Object.values(resp.temas)[0] : null);
    const normalized = normalizarDificultad(crudo, idsDelCatalogo(catalogo), id, crearResolver(temasDelCatalogo(catalogo)));
    if (!normalized || !Number.isInteger(normalized.nivel)) {
      difficultyDiagnostics.lastError = `model answer without a usable level: ${JSON.stringify(resp).slice(0, 300)}`;
    }
    return applyLevelFloor(normalized, levelsOf(catalogo));
  } catch (err) {
    difficultyDiagnostics.lastError = String(err && err.message || err).slice(0, 300);
    console.warn(`[dificultad] no pude calcular la dificultad de "${tema}" (${String(err.message).slice(0, 160)}); el tema se publica sin ella`);
    return {};
  }
}
