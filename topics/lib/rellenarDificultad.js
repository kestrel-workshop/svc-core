// Rellena "dificultad" y "requiere" en los temas que ya están en el KV (subject_JSON). Lo usan el endpoint
// POST /rellenar-dificultad (corre donde ya están las claves) y scripts/rellenar-dificultad.mjs.
//
// Reglas:
//  - Solo AGREGA campos que faltan; nunca pisa una dificultad o un "requiere" que ya exista.
//  - En español, "requiere" sale primero de src/data/semilla-requiere-es.json (relaciones revisadas);
//    la IA solo completa lo que la semilla no tiene. La dificultad siempre la pone la IA.
//  - Sin ciclos. Solo toca <materia>.json; no toca fórmulas, práctica, examen ni archivos.
import fs from "node:fs";
import { leerJSON, escribirJSON, keyMateria } from "./kv.js";
import { readSubject, saveSubject } from "./pages.js";
import { cargarCatalogo, invalidarCatalogo } from "./catalogo.js";
import { llamarIA } from "./iaLigera.js";
import { armarPromptDificultad } from "../prompts/dificultad.js";
import { normalizarDificultad, sinCiclos, repartirNiveles, MIN_TEMAS_REPARTO, crearResolver, applyLevelFloor } from "./dificultad.js";
import { slugify } from "./slugify.js";

const MAX_FALLOS_SEGUIDOS = 3;   // si la IA falla tantas veces seguidas se corta: seguir solo gasta tiempo
const PAUSA_ENTRE_LLAMADAS_MS = 1500;

export async function consultarIA({ system, prompt }) {
  return llamarIA({ system, prompt, model: "claude-sonnet-5-5", parseJson: true, maxTokens: 4000 });
}

export function cargarSemilla(idioma) {
  if (idioma !== "es") return {};
  return JSON.parse(fs.readFileSync(new URL("../data/semilla-requiere-es.json", import.meta.url), "utf8"));
}

/**
 * @returns {{ idioma, aplicar, materias: [{id, titulo, cambios:[{id,titulo,dificultad,requiere}], original}], resumen }}
 *   `original` es el JSON de la materia ANTES de cambiarlo (para guardar como respaldo).
 */
export async function rellenarDificultad({ idioma = "es", aplicar = false, solo = null, recalcular = false, fillLevel = false, log = () => {}, consultar = consultarIA, pausaMs = PAUSA_ENTRE_LLAMADAS_MS } = {}) {
  const semilla = cargarSemilla(idioma);
  invalidarCatalogo(idioma);
  const catalogo = await cargarCatalogo(idioma);
  if (!catalogo) throw new Error("No pude leer el catálogo del KV");
  const temasCatalogo = catalogo.materias.flatMap((m) => m.temas.map((t) => ({ id: t.id, titulo: t.titulo })));
  const idsValidos = new Set(temasCatalogo.map((t) => t.id));
  const resolver = crearResolver(temasCatalogo);
  log(`Idioma ${idioma}: ${catalogo.materias.length} materias, ${idsValidos.size} temas. Modo: ${aplicar ? "APLICAR" : "solo mostrar"}${recalcular ? " · RECALCULAR dificultades" : ""}${fillLevel ? " · SOLO NIVEL" : ""}`);

  // 1) leer todo
  const trabajos = [];
  for (const m of catalogo.materias) {
    if (solo && m.id !== solo) continue;
    const datos = await readSubject(m.id, idioma);
    if (!datos || !Array.isArray(datos.temas)) continue;
    for (const t of datos.temas) if (!t.id) t.id = slugify((t.titulo || "").trim());
    trabajos.push({ materia: m, datos, original: JSON.stringify(datos) });
  }

  // 2) IA: una consulta por materia con los temas que todavía no tienen dificultad (o requiere sin semilla)
  let abortado = null, fallosSeguidos = 0;
  for (const tr of trabajos) {
    const pendientes = tr.datos.temas.filter((t) => fillLevel ? t.nivel === undefined : (recalcular || t.dificultad === undefined || (t.requiere === undefined && !semilla[t.id])));
    if (!pendientes.length) continue;
    if (abortado) { tr.falloIA = "no consultada (se cortó el relleno)"; continue; }
    const { system, prompt } = armarPromptDificultad(pendientes.map((t) => ({ id: t.id, titulo: t.titulo, materia: tr.materia.titulo })), catalogo, idioma);
    try {
      const resp = await consultar({ system, prompt });
      // la IA a veces cambia un poco los ids (sobre todo en idiomas con escritura propia): se reconocen igual
      tr.ia = {};
      let sinReconocer = 0;
      for (const [k, v] of Object.entries(resp?.temas || {})) {
        const real = resolver(k);
        if (real) tr.ia[real] = v; else sinReconocer++;
      }
      if (sinReconocer) log(`  ${tr.materia.id}: ${sinReconocer} respuestas de la IA no coinciden con ningún tema`);
      fallosSeguidos = 0;
      log(`  ${tr.materia.id}: la IA evaluó ${Object.keys(tr.ia).length}/${pendientes.length} temas`);
    } catch (err) {
      tr.falloIA = String(err.message).slice(0, 220);
      fallosSeguidos++;
      log(`  ! ${tr.materia.id}: la IA falló (${tr.falloIA}); se salta esta materia`);
      if (fallosSeguidos >= MAX_FALLOS_SEGUIDOS) {
        abortado = `La IA falló ${MAX_FALLOS_SEGUIDOS} veces seguidas; se cortó el relleno. Probá de nuevo más tarde (es seguro repetirlo: solo agrega lo que falta).`;
        log(abortado);
      }
    }
    if (pausaMs) await new Promise((r) => setTimeout(r, pausaMs));
  }

  // 3) armar el resultado, sin pisar nada y sin ciclos
  const mapa = {};
  for (const tr of trabajos) for (const t of tr.datos.temas) if (Array.isArray(t.requiere)) mapa[t.id] = t.requiere.slice();
  let dificultades = 0, vinculos = 0, descartados = 0, niveles = 0;
  const levelsById = new Map();
  for (const tr of trabajos) for (const t of tr.datos.temas) if (Number.isInteger(t.nivel)) levelsById.set(t.id, t.nivel);

  // Dificultad: si se evaluó mucho catálogo junto, los niveles se reparten por ranking (la IA tiende a irse al
  // medio, pero el orden que da sirve); con pocos temas se usan los umbrales fijos del puntaje.
  const aEvaluar = [];
  for (const tr of trabajos) {
    for (const t of tr.datos.temas) {
      if (fillLevel || !(recalcular || t.dificultad === undefined)) continue;
      const ia = normalizarDificultad(tr.ia?.[t.id], idsValidos, t.id, resolver);
      if (ia.puntaje !== undefined) aEvaluar.push({ id: t.id, puntaje: ia.puntaje });
    }
  }
  const porRanking = aEvaluar.length >= MIN_TEMAS_REPARTO ? repartirNiveles(aEvaluar) : null;
  log(`Dificultad: ${aEvaluar.length} temas con puntaje; reparto ${porRanking ? "por ranking" : "por umbrales fijos"}`);

  for (const tr of trabajos) {
    for (const t of tr.datos.temas) {
      const ia = normalizarDificultad(tr.ia?.[t.id], idsValidos, t.id, resolver);
      if (fillLevel) {
        if (t.nivel === undefined && Number.isInteger(ia.nivel)) {
          const floored = applyLevelFloor({ nivel: ia.nivel, requiere: Array.isArray(t.requiere) ? t.requiere : ia.requiere || [] }, levelsById);
          t.nivel = floored.nivel;
          levelsById.set(t.id, t.nivel);
          niveles++;
        }
        continue;
      }
      if (recalcular || t.dificultad === undefined) {
        const nivel = porRanking && porRanking[t.id] ? porRanking[t.id] : ia.dificultad;
        if (nivel && nivel !== t.dificultad) { t.dificultad = nivel; dificultades++; }
      }
      if (t.requiere === undefined && (semilla[t.id] || tr.ia)) {
        const candidatos = semilla[t.id] ? semilla[t.id].filter((x) => idsValidos.has(x) && x !== t.id) : (ia.requiere || []);
        const buenos = [];
        for (const c of candidatos) {
          if (sinCiclos(t.id, [c], mapa).length) buenos.push(c); else descartados++;
        }
        t.requiere = buenos;
        mapa[t.id] = buenos;
        vinculos += buenos.length;
      }
    }
  }
  const distribucion = {};
  for (const tr of trabajos) for (const t of tr.datos.temas) if (t.dificultad) distribucion[t.dificultad] = (distribucion[t.dificultad] || 0) + 1;

  // 4) escribir (si se pidió) y devolver el informe
  const materias = [];
  for (const tr of trabajos) {
    if (JSON.stringify(tr.datos) === tr.original) {
      if (tr.falloIA) materias.push({ id: tr.materia.id, titulo: tr.materia.titulo, cambios: [], falloIA: tr.falloIA });
      continue;
    }
    const antes = JSON.parse(tr.original);
    const cambios = tr.datos.temas
      .filter((t, i) => JSON.stringify(t) !== JSON.stringify(antes.temas[i]))
      .map((t) => ({ id: t.id, titulo: t.titulo, dificultad: t.dificultad ?? null, nivel: t.nivel ?? null, requiere: t.requiere ?? null }));
    if (aplicar) {
      await saveSubject(tr.materia.id, idioma, tr.datos);
      log(`  -> ${tr.materia.id} escrito en el KV`);
    }
    materias.push({ id: tr.materia.id, titulo: tr.materia.titulo, cambios, falloIA: tr.falloIA || null, original: aplicar ? antes : undefined });
  }
  if (aplicar) invalidarCatalogo(idioma);
  const resumen = { distribucion, materiasConCambios: materias.filter((m) => m.cambios.length).length, dificultades, niveles, vinculos, descartadosPorCiclo: descartados, materiasConFalloIA: trabajos.filter((t) => t.falloIA).length };
  log(`Resumen: ${JSON.stringify(resumen)}`);
  return { idioma, aplicar, abortado, materias, resumen };
}
