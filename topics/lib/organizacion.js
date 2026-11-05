// Registro de organización: UN concepto por tema, independiente del idioma, en el KV "organization_JSON".
//
//   organizacion.json = {
//     version: 1, actualizado: "…",
//     materias: { "<id es de la materia>": { area, ids: { es: "calculo_diferencial", en: "differential_calculus", … } } },
//     temas:    { "<clave>": { materia, titulo, dificultad, requiere: ["<clave>", …], ids: { es: "derivadas", en: "derivatives", ko: "도함수" } } }
//   }
//
// La clave de un concepto es su id en español. Un concepto sin id en español (nació en otro idioma) usa "<idioma>:<id>".
// «ids[idioma]» dice con qué id local se generó el tema en ese idioma: si falta, ese idioma todavía no lo tiene.
// La dificultad y los temas previos se guardan UNA vez aquí (y con claves, no con ids locales), así son iguales en
// todos los idiomas y no se rompen cuando cambia un id.
import fs from "node:fs";
import { leerJSON, keyMaterias, keyMateria } from "./kv.js";
import { readSubject } from "./pages.js";
import { leerOrgJSON, escribirOrgJSON, orgHabilitada } from "./kvOrg.js";
import { consultarIA } from "./rellenarDificultad.js";
import { armarPromptEmparejar } from "../prompts/emparejar.js";
import { crearResolver, normalizarDificultad, sinCiclos } from "./dificultad.js";
import { armarPromptDificultad } from "../prompts/dificultad.js";
import { slugify } from "./slugify.js";

export const ORG_KEY = "organizacion.json";
export const IDIOMAS = ["es", "en", "pt", "fr", "de", "ja", "zh", "ko", "ru", "ar", "hi", "id"];
const EN_A_ES = JSON.parse(fs.readFileSync(new URL("../data/materias-en-es.json", import.meta.url), "utf8"));
const PAUSA_MS = 1500;

export const registroVacio = () => ({ version: 1, actualizado: null, materias: {}, temas: {} });
// Id de materia en español a partir del id local (las materias de los otros idiomas usan el id en inglés).
export const materiaEs = (idMateria) => EN_A_ES[idMateria] || idMateria;

// Escrituras de a una: leer-modificar-escribir sin que dos pedidos se pisen dentro de este proceso.
let cola = Promise.resolve();
export function conMutex(fn) {
  const r = cola.then(() => fn());
  cola = r.catch(() => {});
  return r;
}

export async function leerRegistro() {
  const r = await leerOrgJSON(ORG_KEY);
  return r && r.temas ? r : registroVacio();
}
export async function guardarRegistro(reg) {
  reg.actualizado = new Date().toISOString();
  await escribirOrgJSON(ORG_KEY, reg);
}

/**
 * Empareja los temas locales de una materia con los conceptos candidatos (mismo tema, traducido).
 * `directo`: si hay uno solo de cada lado se emparejan sin preguntar (sirve al armar el registro entero; no al
 * registrar un tema suelto, que podría ser un tema nuevo de verdad).
 * @returns {{ pares: { [idLocal]: clave }, sinPar: string[] }}
 */
export async function emparejar({ locales, candidatos, idioma, consultar = consultarIA, directo = true }) {
  if (!locales.length) return { pares: {}, sinPar: [] };
  if (!candidatos.length) return { pares: {}, sinPar: locales.map((l) => l.id) };
  if (directo && locales.length === 1 && candidatos.length === 1) return { pares: { [locales[0].id]: candidatos[0].clave }, sinPar: [] };
  const { system, prompt } = armarPromptEmparejar(locales, candidatos, idioma);
  const resp = await consultar({ system, prompt });
  const resLocal = crearResolver(locales.map((l) => ({ id: l.id, titulo: l.titulo })));
  const resCand = crearResolver(candidatos.map((c) => ({ id: c.clave, titulo: c.titulo })));
  const pares = {}, usadas = new Set();
  for (const [k, v] of Object.entries(resp?.pares || {})) {
    const idLocal = resLocal(k);
    const clave = v == null ? null : resCand(String(v));
    if (!idLocal || !clave || pares[idLocal] || usadas.has(clave)) continue;
    pares[idLocal] = clave;
    usadas.add(clave);
  }
  return { pares, sinPar: locales.filter((l) => !pares[l.id]).map((l) => l.id) };
}

/**
 * Dificultad y temas previos de los conceptos que todavía no tienen dificultad (temas que existen en un solo idioma,
 * sin equivalente en español). Una consulta por materia; si la IA falla, quedan sin dificultad y se reintenta la
 * próxima vez que se construya. Modifica `reg` y devuelve cuántos completó.
 */
export async function evaluarConceptosSinDificultad(reg, { consultar = consultarIA, log = () => {}, pausaMs = PAUSA_MS } = {}) {
  const pendientes = Object.entries(reg.temas).filter(([, c]) => c.dificultad == null);
  if (!pendientes.length) return 0;
  const catalogo = { materias: [] };
  const porMateria = {};
  for (const [clave, c] of Object.entries(reg.temas)) (porMateria[c.materia] = porMateria[c.materia] || []).push({ id: clave, titulo: c.titulo });
  for (const [m, temas] of Object.entries(porMateria)) catalogo.materias.push({ id: m, titulo: m, temas });
  const resolver = crearResolver(Object.entries(reg.temas).map(([clave, c]) => ({ id: clave, titulo: c.titulo })));
  const mapa = {};
  for (const [clave, c] of Object.entries(reg.temas)) if (Array.isArray(c.requiere)) mapa[clave] = c.requiere.slice();
  let completados = 0;
  const grupos = {};
  for (const [clave, c] of pendientes) (grupos[c.materia] = grupos[c.materia] || []).push([clave, c]);
  for (const [materia, lista] of Object.entries(grupos)) {
    const { system, prompt } = armarPromptDificultad(lista.map(([clave, c]) => ({ id: clave, titulo: c.titulo, materia })), catalogo, "es");
    try {
      const resp = await consultar({ system, prompt });
      for (const [k, v] of Object.entries(resp?.temas || {})) {
        const clave = resolver(k);
        const c = clave && reg.temas[clave];
        if (!c || c.dificultad != null) continue;
        const n = normalizarDificultad(v, new Set(Object.keys(reg.temas)), clave, resolver);
        if (n.dificultad) { c.dificultad = n.dificultad; completados++; }
        if (c.requiere == null && Array.isArray(n.requiere)) {
          c.requiere = n.requiere.filter((r) => sinCiclos(clave, [r], mapa).length);
          mapa[clave] = c.requiere;
        }
      }
      if (pausaMs) await new Promise((r) => setTimeout(r, pausaMs));
    } catch (err) {
      log(`  ! dificultad de los temas propios de ${materia}: ${String(err.message).slice(0, 120)}`);
    }
  }
  return completados;
}

/**
 * Arma (o completa) el registro a partir de los catálogos que ya existen en el KV de contenido.
 *   1) Cada tema del español es un concepto (con su dificultad y sus temas previos si ya los tiene).
 *   2) Los temas de cada otro idioma se emparejan con los conceptos: primero materia por materia, después con lo que
 *      sobró de cada materia y al final con todos los conceptos que aún no tienen ese idioma.
 *   3) Lo que sigue sin equivalente es un tema propio de ese idioma: recibe su propio concepto ("<idioma>:<id>") y
 *      una dificultad evaluada por la IA.
 * Es INCREMENTAL: parte del registro que ya está en el KV (si existe) y conserva lo escrito antes (ids de otros idiomas,
 * conceptos propios). `desdeCero: true` ignora lo anterior. No escribe nada si aplicar=false.
 */
export async function construirOrganizacion({ aplicar = false, idiomas = null, desdeCero = false, log = () => {}, consultar = consultarIA, pausaMs = PAUSA_MS, base = undefined } = {}) {
  let reg = registroVacio();
  if (!desdeCero) {
    try { reg = base !== undefined ? (base || registroVacio()) : (orgHabilitada() ? await leerRegistro() : registroVacio()); }
    catch (err) { log(`  ! no pude leer el registro anterior (${String(err.message).slice(0, 100)}); parto de cero`); reg = registroVacio(); }
  }
  const sinPar = {};
  const esperar = () => (pausaMs ? new Promise((r) => setTimeout(r, pausaMs)) : null);

  // 1) español
  const indiceEs = await leerJSON(keyMaterias("es"));
  const materiasEs = (indiceEs?.materias || []).filter((m) => m?.id);
  if (!materiasEs.length) throw new Error("No pude leer el índice de materias en español");
  for (const m of materiasEs) {
    reg.materias[m.id] = { area: m.grupo || "", ids: { ...(reg.materias[m.id]?.ids || {}), es: m.id } };
    const datos = await readSubject(m.id, "es");
    for (const t of datos?.temas || []) {
      const clave = t.id || slugify((t.titulo || "").trim());
      if (!clave) continue;
      const previo = reg.temas[clave];
      reg.temas[clave] = {
        materia: m.id,
        titulo: t.titulo,
        // lo del JSON en español manda (ahí se recalcula); si no trae nada, se conserva lo que ya había
        dificultad: t.dificultad ?? previo?.dificultad ?? null,
        requiere: Array.isArray(t.requiere) ? t.requiere : previo?.requiere ?? null,
        ids: { ...(previo?.ids || {}), es: clave },
      };
    }
  }
  for (const c of Object.values(reg.temas)) if (c.requiere) c.requiere = c.requiere.filter((k) => reg.temas[k]);
  log(`Español: ${materiasEs.length} materias, ${Object.keys(reg.temas).length} conceptos`);

  const enlazado = (idioma, id) => Object.values(reg.temas).some((c) => c.ids[idioma] === id);
  const libres = (idioma, filtro) => Object.entries(reg.temas).filter(([, c]) => !c.ids[idioma] && (!filtro || filtro(c))).map(([clave, c]) => ({ clave, titulo: c.titulo }));
  const unir = (idioma, pares, mapaLocal) => {
    let n = 0;
    for (const [idLocal, clave] of Object.entries(pares)) { if (reg.temas[clave] && !reg.temas[clave].ids[idioma]) { reg.temas[clave].ids[idioma] = idLocal; n++; } }
    return n;
  };

  // 2) otros idiomas
  for (const idioma of (idiomas || IDIOMAS).filter((l) => l !== "es")) {
    const indice = await leerJSON(keyMaterias(idioma));
    const materias = (indice?.materias || []).filter((m) => m?.id);
    if (!materias.length) { log(`${idioma}: sin catálogo, se salta`); continue; }
    let emparejados = 0;
    const falta = [];                        // [{ materia, id, titulo }]
    for (const m of materias) {
      const esId = materiaEs(m.id);
      if (!reg.materias[esId]) reg.materias[esId] = { area: m.grupo || "", ids: {} };
      reg.materias[esId].ids[idioma] = m.id;
      const datos = await readSubject(m.id, idioma);
      const locales = (datos?.temas || []).map((t) => ({ id: t.id || slugify((t.titulo || "").trim()), titulo: t.titulo })).filter((t) => t.id && !enlazado(idioma, t.id));
      if (!locales.length) continue;
      try {
        // pasada 1: candidatos de la misma materia (o, si la materia no se reconoce, todos los libres)
        const mismos = libres(idioma, (c) => c.materia === esId);
        const cand1 = mismos.length ? mismos : libres(idioma);
        const r1 = await emparejar({ locales, candidatos: cand1, idioma, consultar });
        emparejados += unir(idioma, r1.pares);
        let sobran = locales.filter((l) => !r1.pares[l.id]);
        // pasada 2: lo que sobró contra los candidatos que sobraron de la misma materia (un problema más chico)
        if (sobran.length) {
          const cand2 = libres(idioma, (c) => c.materia === esId);
          if (cand2.length) {
            const r2 = await emparejar({ locales: sobran, candidatos: cand2, idioma, consultar });
            emparejados += unir(idioma, r2.pares);
            sobran = sobran.filter((l) => !r2.pares[l.id]);
          }
        }
        for (const l of sobran) falta.push({ materia: m.id, id: l.id, titulo: l.titulo });
        await esperar();
      } catch (err) {
        for (const l of locales) falta.push({ materia: m.id, id: l.id, titulo: l.titulo });
        log(`  ! ${idioma}/${m.id}: no pude emparejar (${String(err.message).slice(0, 120)})`);
      }
    }
    // pasada 3: lo que sigue sin pareja contra TODOS los conceptos que todavía no tienen este idioma
    let todavia = falta;
    if (falta.length) {
      try {
        const locales = falta.map((f) => ({ id: f.id, titulo: f.titulo }));
        const r3 = await emparejar({ locales, candidatos: libres(idioma), idioma, consultar, directo: false });
        emparejados += unir(idioma, r3.pares);
        todavia = falta.filter((f) => !r3.pares[f.id]);
        await esperar();
      } catch (err) { log(`  ! ${idioma}: pasada global (${String(err.message).slice(0, 120)})`); }
    }
    // temas propios del idioma: concepto nuevo ("<idioma>:<id>")
    let propios = 0;
    for (const f of todavia) {
      const clave = `${idioma}:${f.id}`;
      const esMat = materiaEs(f.materia);
      if (!reg.temas[clave]) { reg.temas[clave] = { materia: esMat, titulo: f.titulo, dificultad: null, requiere: null, ids: { [idioma]: f.id } }; propios++; }
    }
    sinPar[idioma] = todavia.map((f) => `${f.materia}/${f.id}`);
    log(`${idioma}: ${emparejados} temas emparejados, ${propios} temas propios`);
  }

  // 3) dificultad de los conceptos propios
  const completados = await evaluarConceptosSinDificultad(reg, { consultar, log, pausaMs });
  if (completados) log(`Dificultad evaluada para ${completados} temas propios de un idioma`);

  const conceptos = Object.keys(reg.temas).length;
  const resumen = {
    conceptos,
    sinDificultad: Object.values(reg.temas).filter((c) => c.dificultad == null).length,
    porIdioma: Object.fromEntries(IDIOMAS.map((l) => [l, Object.values(reg.temas).filter((c) => c.ids[l]).length])),
    temasPropios: sinPar,
  };
  if (aplicar) { await guardarRegistro(reg); log("Registro escrito en el KV de organización"); }
  return { registro: reg, resumen };
}

/**
 * Se llama al crear un tema (lib/generar.js). Lo enlaza con su concepto o crea uno nuevo.
 *  - español: concepto nuevo con la dificultad y los temas previos calculados.
 *  - otro idioma: se empareja con un concepto existente de la misma materia; si no hay equivalente, concepto propio.
 * Si el KV de organización no está configurado devuelve null y no hace nada.
 * `extra` = { dificultad?, requiere? } con los ids LOCALES (como los calcula lib/dificultad.js).
 */
export async function registrarTemaNuevo({ idioma, materia, id, titulo, extra = null, consultar = consultarIA }) {
  if (!orgHabilitada()) return null;
  try {
    return await conMutex(async () => {
      const reg = await leerRegistro();
      const esMateria = materiaEs(materia);
      if (!reg.materias[esMateria]) reg.materias[esMateria] = { area: "", ids: {} };
      reg.materias[esMateria].ids[idioma] = materia;
      if (!reg.materias[esMateria].area) {
        try {
          const indice = await leerJSON(keyMaterias("es"));
          const entrada = (indice?.materias || []).find((m) => m?.id === esMateria);
          if (entrada?.grupo) reg.materias[esMateria].area = entrada.grupo;
        } catch {}
      }

      const yaEnlazado = Object.entries(reg.temas).find(([, c]) => c.ids[idioma] === id);
      if (yaEnlazado) return { clave: yaEnlazado[0], nuevo: false };

      // temas previos locales -> claves
      const aClave = (idLocal) => Object.entries(reg.temas).find(([, c]) => c.ids[idioma] === idLocal)?.[0] || (idioma === "es" && reg.temas[idLocal] ? idLocal : null);
      const requiere = (extra?.requiere || []).map(aClave).filter(Boolean);
      const dificultad = Number.isInteger(extra?.dificultad) ? extra.dificultad : null;

      let clave = null;
      if (idioma !== "es") {
        const candidatos = Object.entries(reg.temas).filter(([, c]) => c.materia === esMateria && !c.ids[idioma]).map(([k, c]) => ({ clave: k, titulo: c.titulo }));
        if (candidatos.length) {
          const { pares } = await emparejar({ locales: [{ id, titulo }], candidatos, idioma, consultar, directo: false });
          clave = pares[id] || null;
        }
      }
      if (clave) {                                  // es un tema que ya existe en otro idioma: manda lo que ya está
        reg.temas[clave].ids[idioma] = id;
        await guardarRegistro(reg);
        return { clave, nuevo: false };
      }
      clave = idioma === "es" ? id : `${idioma}:${id}`;
      if (reg.temas[clave]) { reg.temas[clave].ids[idioma] = id; }
      else reg.temas[clave] = { materia: esMateria, titulo, dificultad, requiere, ids: { [idioma]: id } };
      await guardarRegistro(reg);
      return { clave, nuevo: true };
    });
  } catch (err) {
    console.warn(`[organizacion] no pude registrar "${titulo}" (${idioma}): ${String(err.message).slice(0, 160)}`);
    return null;
  }
}
