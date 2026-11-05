import "./env.js";
import { llamarIA as llamarIALigera } from "./lib/iaLigera.js";
import { llamarClaude as llamarIAClaude } from "./lib/anthropic.js";
import { armarPromptIA2 } from "./prompts/ia2.js";
import { armarPromptClasificar, MATERIAS_RETIRADAS, EQUIVALENCIAS_MATERIA, EQUIVALENCIAS_INVERSAS } from "./prompts/clasificar.js";
import { cargarCatalogo, buscarTemaExistente } from "./lib/catalogo.js";
import { leerJSON, keyMaterias, keyMateria } from "./lib/kv.js";
import { readSubject } from "./lib/pages.js";
import { slugify } from "./lib/slugify.js";
import { registerTopic } from "./lib/registerTopic.js";
import { traducirTermino } from "./lib/traducir.js";

export function esErrorDeCreditoAnthropic(err) {
  const msg = (err?.message || "").toLowerCase();
  return (
    msg.includes("credit balance") ||
    msg.includes("429") ||
    msg.includes("insufficient") ||
    msg.includes("quota") ||
    msg.includes("401") ||
    msg.includes("authentication_error") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("permission_error") ||
    msg.includes("not_found_error")
  );
}

// FIX (bug "todo cae en Sin clasificar fuera de español"): esto antes
// validaba el propio "grupo" (texto libre, YA traducido al idioma de la
// instancia por armarPromptClasificar) contra una lista fija en español.
// Resultado: en CUALQUIER instancia no-española, la IA devolvía "grupo"
// correctamente traducido (ej. "Applied sciences"), ese texto nunca
// matcheaba ninguno de los 3 strings españoles hardcodeados acá, "grupo"
// quedaba null, y como abajo se exige título+grupo para aceptar una
// materia nueva, la clasificación entera se descartaba -- la materia
// terminaba SIEMPRE con "materia: null" y caía en "Sin clasificar",
// nunca importa qué tan bien hubiera clasificado la IA.
//
// Ahora validamos "grupoClave" (ver prompts/clasificar.js): una clave
// FIJA en inglés que la IA nunca traduce, sin importar el idioma de la
// instancia. El texto human-readable "grupo" ya no se valida contra una
// lista -- se confía en él tal cual lo devolvió la IA (ya viene con
// instrucciones de redacción consistente en el prompt), solo se exige
// que no venga vacío.
const GRUPOS_CLAVE_VALIDAS = ["exactas", "aplicadas", "no_obvias"];

// Red de seguridad SOLO para compatibilidad hacia atrás: si por lo que
// sea la IA no mandó "grupoClave" (ej. un modelo de fallback que todavía
// no vio el prompt actualizado) pero "grupo" vino con uno de los 3
// strings españoles exactos de siempre, lo mapeamos igual en vez de
// descartar la clasificación. Fuera de español, si no vino grupoClave no
// hay forma confiable de inferir la clave desde texto libre traducido,
// así que en ese caso sí se descarta (mejor "Sin clasificar" ocasional
// que confiar en un match de texto que puede fallar en silencio).
const GRUPO_TEXTO_ES_A_CLAVE = {
  "Ciencias exactas": "exactas",
  "Ciencias aplicadas": "aplicadas",
  "Aplicaciones no obvias": "no_obvias",
};

/**
 * Normaliza y valida lo que devolvió la IA (Mistral o Claude) para
 * /clasificar, así el resto del endpoint no tiene que desconfiar del
 * shape del JSON en cada uso.
 *
 * OJO - caso "materia nueva sin id": cuando esNueva=true, la IA a veces
 * manda materia=null y solo un "titulo" prolijo (ej: "Combinatoria"),
 * esperando que nosotros derivemos el id (ej: "combinatoria"). Antes este
 * caso se descartaba entero apenas materia venía null, aunque titulo y
 * grupo fueran válidos - eso tiraba a la basura propuestas correctas de
 * materia nueva. Ahora, si esNueva=true y no vino "materia" pero sí un
 * titulo utilizable, derivamos el id con slugify(titulo) antes de seguir.
 *
 * Este id derivado por slugify SOLO se usa cuando la IA no devolvió un
 * "materia" ya elegido (ni local ni canónico, ver armarPromptClasificar) -
 * si el prompt tiene la lista de ids canónicos y la IA hizo bien su
 * trabajo, "materia" ya viene con el id canónico reutilizado y esta rama
 * ni se ejecuta.
 *
 * FIX (URLs en idiomas no-latinos -- ver conversación 19/09): "materia"
 * es un id que termina tal cual en la URL del sitio (?materia=...), y
 * ahora tiene que ser SIEMPRE inglés (ver la nota nueva en
 * armarPromptClasificar). Acá validamos eso con una regla determinística
 * -- /^[a-z0-9_]+$/ -- en las DOS fuentes posibles de "materia":
 *   1) el campo que mandó la IA directo (por si no respetó la instrucción
 *      de idioma del prompt -- los LLMs no son 100% confiables con esto),
 *   2) el fallback de acá abajo que deriva el id con slugify(titulo)
 *      cuando la IA no mandó "materia" -- este es el MISMO bug que tenía
 *      agregarTemaAMateria() con "tema": slugify() no transliteran CJK/
 *      cirílico/árabe/etc, así que si "titulo" viene en japonés (que es
 *      lo correcto para "titulo", ver nota de idioma), este fallback
 *      terminaba produciendo un id roto en script no-latino.
 * Si el id no pasa la regla, se descarta (como si "materia" nunca
 * hubiera llegado) en vez de guardarse -- la clasificación cae en el
 * camino que ya existe para "no se pudo clasificar" (ver
 * clasificarYValidarConReintento, que reintenta con Claude en ese caso).
 * Preferible perder alguna clasificación ocasional a persistir un id
 * irrecuperable en KV/URLs.
 */
const ID_MATERIA_VALIDO = /^[a-z0-9_]+$/;

function normalizarResultadoClasificacion(resultado, materiasExistentes, gruposExistentes = []) {
  let esNueva = resultado?.esNueva === true;
  let materia = typeof resultado?.materia === "string" ? resultado.materia.trim() : null;
  if (materia && !ID_MATERIA_VALIDO.test(materia)) {
    materia = null; // la IA no respetó "id siempre en inglés" -- no confiamos en esto
  }
  // Organización por ramas: si la IA devolvió un id que no está en la lista pero tiene equivalente
  // (id español <-> inglés de la misma materia), usamos el que SÍ existe en esta instancia. Y las
  // materias generales ya retiradas (calculus, physics, ...) nunca se vuelven a crear: se descartan
  // para que el flujo pida segunda opinión en vez de ensuciar el índice.
  if (materia && !materiasExistentes.includes(materia)) {
    const equiv = EQUIVALENCIAS_MATERIA[materia] || EQUIVALENCIAS_INVERSAS[materia];
    if (equiv && materiasExistentes.includes(equiv)) {
      materia = equiv;
      esNueva = false;
    } else if (MATERIAS_RETIRADAS.has(materia)) {
      materia = null;
    }
  }
  const confianza = ["alta", "media", "baja"].includes(resultado?.confianza) ? resultado.confianza : "baja";

  if (!materia && esNueva) {
    const tituloParaId = typeof resultado?.titulo === "string" ? resultado.titulo.trim() : "";
    if (tituloParaId) {
      const candidato = slugify(tituloParaId).replace(/-/g, "_");
      // Ver nota arriba: si "titulo" vino en script no-latino, slugify()
      // no lo convierte a ASCII -- no usamos ese resultado como id.
      // (los ids de materias generales ya retiradas no se reviven por esta vía)
      if (ID_MATERIA_VALIDO.test(candidato) && (materiasExistentes.includes(candidato) || !MATERIAS_RETIRADAS.has(candidato))) {
        materia = candidato;
      }
    }
  }

  if (!materia) {
    return { materia: null, esNueva: false, titulo: null, grupo: null, confianza };
  }

  if (!esNueva) {
    // Tiene que ser una materia que ya existe; si la IA "inventó" un id que
    // no está en la lista sin marcar esNueva, no confiamos en eso. Pero si
    // la IA se equivocó de flag (dijo esNueva=false para algo que en
    // realidad no existe todavía), no lo descartamos sin más: lo tratamos
    // como propuesta de materia nueva igual, con título de respaldo (el
    // propio id, ya que no tenemos un "titulo" prolijo en este caso) y
    // grupo "Sin clasificar", en vez de perder la clasificación entera.
    if (!materiasExistentes.includes(materia)) {
      return {
        materia,
        esNueva: true,
        titulo: null, // se usa el título de respaldo derivado del id, ver actualizarJson.js
        grupo: null,  // se usa "Sin clasificar", ver actualizarJson.js
        confianza: "media",
      };
    }
    return { materia, esNueva: false, titulo: null, grupo: null, confianza };
  }

  // esNueva=true: exigimos título y grupo válidos, si no, no es una
  // propuesta usable.
  const titulo = typeof resultado?.titulo === "string" && resultado.titulo.trim() ? resultado.titulo.trim() : null;
  const grupoTexto = typeof resultado?.grupo === "string" && resultado.grupo.trim() ? resultado.grupo.trim() : null;

  // grupoClave manda: si vino y es una de las 3 válidas, el texto en
  // "grupo" se acepta tal cual (ver comentario arriba de GRUPOS_CLAVE_VALIDAS).
  // Si no vino grupoClave, solo aceptamos el texto vía el fallback de
  // compatibilidad (strings españoles exactos).
  const grupoClave = GRUPOS_CLAVE_VALIDAS.includes(resultado?.grupoClave)
    ? resultado.grupoClave
    : (grupoTexto && GRUPO_TEXTO_ES_A_CLAVE[grupoTexto]) || null;

  // Si el texto coincide con un grupo (área) que YA existe en esta instancia, se usa ese texto literal
  // (el frontend agrupa por texto exacto) y no hace falta grupoClave.
  const grupoExistente = grupoTexto
    ? gruposExistentes.find((g) => g.trim().toLowerCase() === grupoTexto.toLowerCase())
    : null;
  const grupo = grupoExistente || (grupoClave ? grupoTexto : null);
  if (!titulo || !grupo) {
    return { materia: null, esNueva: false, titulo: null, grupo: null, confianza: "baja" };
  }
  return { materia, esNueva: true, titulo, grupo, confianza };
}

/**
 * FIX (números complejos / IA#1 "seguro pero mal" -- 19/09): la segunda
 * opinión de Claude en clasificar() antes solo se pedía si Mistral dudaba
 * (confianza != "alta") o devolvía materia=null. Eso deja un agujero: si
 * Mistral está SEGURO pero se equivoca (ej. "complejos" -> algebra_abstracta
 * con confianza "alta" porque es la única materia que existe en el sitio,
 * cuando el término en realidad merece una materia propia), IA#2 rechaza el
 * tema por no encajar ahí y ahí terminaba todo -- se devolvía "no válido"
 * sin volver a intentar, aunque el término SÍ fuera un tema real, solo mal
 * clasificado.
 *
 * Esta función agrega un segundo nivel de reintento: si IA#2 rechaza el
 * tema (esValido=false, no duplicado) en la materia que eligió Mistral, se
 * le pide a Claude que reclasifique desde cero, pasándole el motivo del
 * rechazo y pidiéndole explícitamente otra materia, y se vuelve a correr
 * IA#2 contra la nueva propuesta antes de rendirse. Un solo reintento (no
 * hay loop): si Claude tampoco da con algo que IA#2 acepte, se devuelve el
 * rechazo original de IA#2 tal cual (el caller decide qué hacer con eso).
 *
 * Devuelve { ok:false, motivo } si no se pudo determinar ninguna materia,
 * o { ok:true, materia, clasificacion, resultadoIA2, sysIA2, promptIA2 }
 * (sysIA2/promptIA2 porque resolverMoldePractica los necesita).
 */
async function clasificarYValidarConReintento({ termino, materiasExistentes, idioma, logPrefix, catalogo = null }) {
  const gruposExistentes = catalogo?.grupos || [];
  const { system: sysClasificar, prompt: promptClasificar } = armarPromptClasificar(termino, materiasExistentes, idioma, catalogo);
  const resultadoMistral = await llamarIALigera({ system: sysClasificar, prompt: promptClasificar, model: "claude-sonnet-5-5", parseJson: true, maxTokens: 300 });
  console.log(`${logPrefix} Mistral crudo para "${termino}":`, JSON.stringify(resultadoMistral));
  let clasificacion = normalizarResultadoClasificacion(resultadoMistral, materiasExistentes, gruposExistentes);
  console.log(`${logPrefix} Mistral normalizado:`, JSON.stringify(clasificacion));

  const necesitaSegundaOpinion = clasificacion.confianza !== "alta" || !clasificacion.materia;
  if (necesitaSegundaOpinion) {
    const motivo = clasificacion.confianza !== "alta" ? `dudó (${clasificacion.confianza})` : `dijo "alta" pero no clasificó nada`;
    console.log(`${logPrefix} Mistral ${motivo} clasificando "${termino}", pido segunda opinión a Claude`);
    try {
      const resultadoClaude = await llamarIAClaude({ system: sysClasificar, prompt: promptClasificar, parseJson: true, maxTokens: 300 });
      console.log(`${logPrefix} Claude crudo para "${termino}":`, JSON.stringify(resultadoClaude));
      const normalizado = normalizarResultadoClasificacion(resultadoClaude, materiasExistentes, gruposExistentes);
      console.log(`${logPrefix} Claude normalizado:`, JSON.stringify(normalizado));
      if (normalizado.confianza === "alta" || (normalizado.materia && (clasificacion.confianza === "baja" || !clasificacion.materia))) {
        clasificacion = normalizado;
      }
    } catch (err) {
      if (esErrorDeCreditoAnthropic(err)) {
        console.warn(`${logPrefix} Claude sin crédito/cuota, sigo con el veredicto de Mistral`);
      } else {
        console.warn(`${logPrefix} Claude falló (${err.message.slice(0, 200)}), sigo con el veredicto de Mistral`);
      }
    }
  }

  if (!clasificacion.materia) {
    console.log(`${logPrefix} "${termino}" no se pudo clasificar en ninguna materia`);
    return { ok: false, motivo: "No se identificó una materia clara para este término" };
  }

  const correrIA2 = async (materiaCandidata, esNueva = false) => {
    const dataMateria = (await readSubject(materiaCandidata, idioma)) || { temas: [], frecuentes: [] };
    const temasExistentes = [...(dataMateria.temas || []), ...(dataMateria.frecuentes || [])];
    const { system: sysIA2, prompt: promptIA2 } = armarPromptIA2(materiaCandidata, termino, temasExistentes, idioma, esNueva);
    const resultadoIA2 = await llamarIALigera({ system: sysIA2, prompt: promptIA2, model: "claude-sonnet-5-5", parseJson: true, maxTokens: 1000 });
    return { resultadoIA2, sysIA2, promptIA2 };
  };

  let materia = clasificacion.materia;
  const yaExiste = await buscarTemaExistente(catalogo, termino, idioma);
  if (yaExiste && yaExiste.materia !== materia) {
    console.log(`${logPrefix} "${termino}" ya existe en "${yaExiste.materia}" (como "${yaExiste.tema}"), uso esa materia en vez de "${materia}"`);
    materia = yaExiste.materia;
    clasificacion = { materia, esNueva: false, titulo: null, grupo: null, confianza: "alta" };
  }
  let { resultadoIA2, sysIA2, promptIA2 } = await correrIA2(materia, clasificacion.esNueva);

  if (!resultadoIA2?.esValido && !resultadoIA2?.esDuplicado) {
    console.log(`${logPrefix} "${termino}" IA#2 rechazó la materia "${materia}" (${resultadoIA2?.razon}), pido a Claude que reclasifique`);
    try {
      const promptReintento = `${promptClasificar}\n\nAclaración: ya se probó con materia="${materia}" y un validador la rechazó por: "${resultadoIA2?.razon || "no encaja"}". Elegí una materia distinta (existente o nueva) que sí encaje.`;
      const resultadoClaudeReintento = await llamarIAClaude({ system: sysClasificar, prompt: promptReintento, parseJson: true, maxTokens: 300 });
      console.log(`${logPrefix} Claude (reintento post-IA#2) crudo para "${termino}":`, JSON.stringify(resultadoClaudeReintento));
      const clasificacionReintento = normalizarResultadoClasificacion(resultadoClaudeReintento, materiasExistentes, gruposExistentes);
      if (clasificacionReintento.materia && clasificacionReintento.materia !== materia) {
        const segundoIntento = await correrIA2(clasificacionReintento.materia, clasificacionReintento.esNueva);
        console.log(`${logPrefix} "${termino}" IA#2 (segundo intento) para materia "${clasificacionReintento.materia}" (esNueva=${clasificacionReintento.esNueva}):`, JSON.stringify(segundoIntento.resultadoIA2));
        if (segundoIntento.resultadoIA2?.esValido || segundoIntento.resultadoIA2?.esDuplicado) {
          console.log(`${logPrefix} "${termino}" reclasificado por Claude a "${clasificacionReintento.materia}", IA#2 lo aceptó`);
          clasificacion = clasificacionReintento;
          materia = clasificacionReintento.materia;
          ({ resultadoIA2, sysIA2, promptIA2 } = segundoIntento);
        } else {
          console.log(`${logPrefix} "${termino}" reclasificado por Claude a "${clasificacionReintento.materia}", pero IA#2 lo rechazó también (${segundoIntento.resultadoIA2?.razon}); sigo con el rechazo original`);
        }
      }
    } catch (err) {
      console.warn(`${logPrefix} reintento de reclasificación con Claude falló (${err.message.slice(0, 200)}), sigo con el rechazo original de IA#2`);
    }
  }

  if (!resultadoIA2?.esValido && !resultadoIA2?.esDuplicado) {
    try {
      const segundaOpinion = await llamarIAClaude({ system: sysIA2, prompt: promptIA2, parseJson: true, maxTokens: 1000 });
      console.log(`${logPrefix} "${termino}" second opinion from Claude on the rejection:`, JSON.stringify(segundaOpinion));
      if (segundaOpinion?.esValido || segundaOpinion?.esDuplicado) {
        resultadoIA2 = segundaOpinion;
      }
    } catch (err) {
      console.warn(`${logPrefix} second opinion from Claude failed (${err.message.slice(0, 200)}), keeping the rejection`);
    }
  }

  return { ok: true, materia, clasificacion, resultadoIA2, sysIA2, promptIA2 };
}

export async function procesarAvisoTema({ termino: terminoOriginal, idioma: idiomaDestino, idiomaOrigen }) {
  if (!terminoOriginal || typeof terminoOriginal !== "string") {
    return { status: 400, payload: { ok: false, motivo: "Falta 'termino'" } };
  }
  const idioma = (idiomaDestino || "es").trim();

  try {
    const termino = await traducirTermino(terminoOriginal, idioma, idiomaOrigen);
    if (termino !== terminoOriginal) {
      console.log(`[aviso-auto] término traducido: "${terminoOriginal}" -> "${termino}"`);
    }

    const catalogo = await cargarCatalogo(idioma, termino);
    const dataMaterias = catalogo ? null : await leerJSON(keyMaterias(idioma));
    const materiasExistentes = catalogo
      ? catalogo.ids
      : Array.isArray(dataMaterias?.materias)
        ? dataMaterias.materias.map((m) => m.id).filter(Boolean)
        : [];
    console.log(`[DEBUG-clasificar] materiasExistentes (${materiasExistentes.length})`);

    const resultadoClasificacion = await clasificarYValidarConReintento({
      termino,
      materiasExistentes,
      idioma,
      logPrefix: "[DEBUG-clasificar]",
      catalogo,
    });
    if (!resultadoClasificacion.ok) {
      return { status: 200, payload: { ok: false, motivo: resultadoClasificacion.motivo } };
    }
    const { materia, clasificacion, resultadoIA2 } = resultadoClasificacion;

    if (!resultadoIA2?.esValido) {
      console.log(`[aviso-auto] "${termino}" IA#2 lo marcó inválido: ${resultadoIA2?.razon}`);
      return { status: 200, payload: { ok: false, motivo: resultadoIA2?.razon || "No es un tema válido para esta biblioteca" } };
    }
    if (resultadoIA2?.esDuplicado) {
      console.log(`[aviso-auto] "${termino}" IA#2 lo marcó duplicado de "${resultadoIA2.tituloExistenteEquivalente}"`);
      return { status: 200, payload: { ok: false, motivo: `Ya existe como "${resultadoIA2.tituloExistenteEquivalente}"` } };
    }
    const topicTitle = resultadoIA2.tituloNormalizado || termino;
    await registerTopic({
      materia,
      tema: topicTitle,
      materiaNuevaInfo: clasificacion.esNueva ? { titulo: clasificacion.titulo, grupo: clasificacion.grupo } : null,
      idioma,
    });
    return { status: 200, payload: { ok: true, materia, slug: slugify(topicTitle), titulo: topicTitle }, idioma };
  } catch (err) {
    console.error("[aviso-auto] error:", err);
    return { status: 500, payload: { ok: false, motivo: err.message } };
  }
}
