import { readFileSync } from "node:fs";

// Datos de referencia de la organización de materias (ver data/materias-ref.json): ids retirados,
// equivalencias es/en y criterio de reparto para casos fronterizos.
const REF = JSON.parse(readFileSync(new URL("../data/materias-ref.json", import.meta.url), "utf8"));
export const MATERIAS_RETIRADAS = new Set(REF.retiradas);
export const EQUIVALENCIAS_MATERIA = REF.equivalencias; // id español -> id inglés (y al revés se deriva abajo)
export const EQUIVALENCIAS_INVERSAS = Object.fromEntries(Object.entries(REF.equivalencias).map(([es, en]) => [en, es]));

/**
 * Arma el prompt para clasificar un término avisado por un usuario
 * ("tangente", "principio de arquímedes", etc.).
 *
 * A diferencia de la versión vieja, esto NO está limitado a la lista de
 * materias que ya existen en el sitio: si el término pertenece a una
 * materia que todavía no está creada (ej. "estequiometría" cuando
 * "quimica" no existe en materias.json todavía), la IA puede proponerla
 * como materia nueva (esNueva=true) en vez de devolver null.
 *
 * @param {string} termino
 * @param {string[]} materias - ids de materia que YA existen EN ESTA
 *   INSTANCIA (índice local, según el idioma), ej: ["algebra", "fisica"]
 * @param {string} [idioma]
 *
 * DECISIÓN (desacople de materia entre idiomas): esta función solía
 * recibir un cuarto parámetro `materiasCanonicas` (ids de materia del
 * índice español) para que una instancia no-española reutilizara el
 * mismo id que "Química" ya tiene en español ("quimica") en vez de
 * derivar uno propio del título traducido ("chemistry"). Eso se sacó a
 * propósito: se decidió que el id de materia NO debe relacionar
 * instancias de distinto idioma entre sí -- cada instancia deriva su
 * propio id a partir de su propio título local, sin cruzarlo contra
 * ningún índice de otro idioma. "chemistry" (en) y "quimica" (es) son
 * ids sin ninguna relación en KV, aunque sean la misma materia
 * conceptual -- es la posición elegida, no un bug pendiente.
 *
 * FIX (grupoClave): además de "grupo" (el texto de la categoría, YA
 * redactado en el idioma de esta instancia, para mostrar en el
 * frontend), ahora también pedimos "grupoClave": una de tres claves
 * FIJAS en inglés ("exactas" | "aplicadas" | "no_obvias") que NUNCA se
 * traducen. Esto es lo que server.js valida para decidir si la
 * clasificación es usable -- antes se validaba el propio "grupo" contra
 * una lista fija en español (GRUPOS_VALIDOS), lo que hacía que CUALQUIER
 * clasificación esNueva=true en una instancia no-española quedara
 * descartada apenas la IA tradujera "grupo" (el texto ya no matcheaba
 * ninguno de los 3 strings españoles hardcodeados) y la materia
 * terminara cayendo en "Sin clasificar" siempre. Con "grupoClave"
 * separado, la validación es independiente del idioma y "grupo" queda
 * libre para mostrarse traducido sin romper nada.
 *
 * FIX (URLs en idiomas no-latinos -- ver conversación 19/09): antes, el
 * "id" de materia seguía la MISMA regla de idioma que "titulo"/"grupo"
 * (ir en el idioma de la instancia). Con idiomas de script latino
 * (en/pt/fr/...) eso da un id razonable igual (slugify ya saca tildes),
 * pero con CJK/cirílico/árabe/etc. el "id" terminaba con texto nativo
 * sin traducir (slugify no transliteran, ver lib/slugify.js) -- y ese id
 * es justo lo que el frontend usa tal cual en la URL (?materia=...). El
 * "titulo" y el "grupo" SÍ deben quedar en el idioma de la instancia
 * (son texto que lee la persona); el "id" es un identificador interno
 * que termina en la URL, así que ahora se pide SIEMPRE en inglés,
 * independientemente de la instancia -- incluida la instancia española
 * (antes ni siquiera tenía esta instrucción explícita, dependía de que
 * la IA razonara en español por el resto del prompt). Esto es a
 * propósito una decisión de producto (URLs consistentes en inglés en
 * todo el sitio), no solo un parche para CJK.
 */
export function armarPromptClasificar(termino, materias, idioma = "es", catalogo = null) {
  const esEspanol = idioma === "es";
  const hayCatalogo = !!(catalogo && catalogo.materias?.length);

  const bulletLogicaVieja = `- "Lógica matemática" (id: "mathematical_logic" -- SIEMPRE este id en inglés, sin
  importar el idioma de esta instancia, ver nota de idioma arriba) y notación/símbolos
  matemáticos (cuantificadores, conjuntos, lenguaje formal) son un tema válido dentro de
  esta materia, aunque todavía no tenga temas cargados: si el término encaja ahí, usá
  materia="mathematical_logic" con esNueva=true (grupoClave "exactas", "grupo" con el
  equivalente de "Ciencias exactas" en el idioma de esta instancia) la primera vez,
  salvo que ya aparezca en la lista de materias existentes.
`;

  const notaIdiomaTituloGrupo = esEspanol
    ? ""
    : `\nIMPORTANTE - idioma de salida: "termino" ya te llega traducido al idioma de esta instancia
(código "${idioma}"). El "titulo" Y el "grupo" de una materia nueva (esNueva=true) tienen que redactarse
en ese mismo idioma ("${idioma}"), aunque estas instrucciones estén en español. Para "grupo": traducí el
concepto de cada una de las tres categorías ("Ciencias exactas" / "Ciencias aplicadas" / "Aplicaciones no
obvias") a "${idioma}", eligiendo SIEMPRE la misma redacción exacta para la misma categoría (ej. en
inglés: "Exact sciences" / "Applied sciences" / "Non-obvious applications") -- esto es importante porque
el frontend agrupa visualmente por el texto literal de "grupo", así que una redacción inconsistente entre
llamadas separa lo que debería estar junto.\n`;

  const notaIdMateria = `\nIMPORTANTE - el "id" de materia SIEMPRE va en inglés, sin importar el idioma
de esta instancia (a diferencia de "titulo" y "grupo", que si corresponde van en el idioma local, ver
arriba) -- las URLs del sitio tienen que quedar consistentes en inglés en cualquier idioma. Traducí vos
mismo el concepto de la materia al inglés y derivá el id de esa traducción (minúsculas, sin tildes ni
espacios, guión bajo en vez de espacio). Ejemplos: término "Química" (instancia en español) -> id=
"chemistry" (NO "quimica"); término "ガロワの理論" / concepto "teoría de Galois" (instancia en japonés,
si esto ameritara una materia nueva) -> id="abstract_algebra" o el id inglés que corresponda al concepto
(NO texto japonés ni romaji). "titulo" y "grupo" no cambian por esto: siguen las reglas de arriba.\n`;


  const bloqueOrganizacion = hayCatalogo ? `
ORGANIZACIÓN DEL SITIO (reglas de este catálogo, tienen prioridad sobre lo anterior):
- Cada materia es una rama ESPECÍFICA y separada; no se mezclan ramas (grafos no es combinatoria, lógica no es conjuntos, etc.).
- Un tema vive en UNA sola materia: aquella donde se estudia primero o con más peso. Si un tema toca varias, elegí la de mayor peso (criterio abajo).
- Si el término ya existe, con ese u otro nombre, en CUALQUIER materia del catálogo (mirá los temas de cada una), devolvé esa misma materia con esNueva=false.
- Preferí SIEMPRE una materia existente. Usá esNueva=true solo si ninguna existente encaja de verdad, y nunca para crear una materia más general o solapada con una existente (no "calculus" si hay cálculo diferencial e integral; no "physics" si hay cinemática, dinámica, etc.).
- Los ids de estas materias generales ya NO existen y no se deben proponer: ${REF.retiradas.join(", ")}.
- Para "grupo" de una materia nueva, usá EXACTAMENTE uno de los grupos que ya existen en el catálogo (texto idéntico): ${catalogo.grupos.map((g) => `"${g}"`).join(", ") || "(ninguno)"}. Solo si ninguno encaja, usá el equivalente de los tres grupos fijos y completá "grupoClave".
- Criterio de reparto para casos fronterizos (porcentaje de pertenencia):
${REF.fronterizos.map((l) => "  * " + l).join("\n")}
` : "";

  const system = `Sos un clasificador de temas para un sitio de referencia de fórmulas y contenido educativo (matemática, ciencias y aplicaciones).
Tu única salida es JSON válido, sin texto antes ni después, sin markdown fences.
${notaIdiomaTituloGrupo}${notaIdMateria}${bloqueOrganizacion}

Te paso un término que un usuario buscó y no encontró en el sitio, y la lista de
materias que YA existen ahí. Tu trabajo es decidir a qué materia pertenece ese término.

Reglas:
- Si el término encaja en una materia de la lista, usá ESE id exacto, con esNueva=false.
- Si el término es ambiguo entre varias materias existentes, elegí la interpretación más
  común y general (ej: "tangente" sin más contexto es de Trigonometría, no de Geometría).
- Si el término NO encaja en ninguna materia de la lista pero sí es un tema real de
  matemática, ciencia o una aplicación seria de estas (ej. "estequiometría" cuando
  "chemistry"/"quimica" no está en la lista), proponé una materia nueva: esNueva=true, con un
  "materia" (id SIEMPRE en inglés -- ver nota de idioma arriba -- en minúsculas, sin tildes
  ni espacios, usá guión bajo si hace falta, ej: "chemistry", "music_theory"), un "titulo" prolijo${esEspanol ? " en español (ej: \"Química\")" : ` en ${idioma}
  ÚNICAMENTE (ej: "Chemistry", NO "Chemistry (Química)")`}, un
  "grupo" que sea el equivalente${esEspanol ? "" : ` en "${idioma}"`} de "Ciencias exactas", "Ciencias
  aplicadas" o "Aplicaciones no obvias" (ver arriba la nota de idioma sobre consistencia de redacción),
  y un "grupoClave" con la clave FIJA correspondiente a esa misma categoría: "exactas",
  "aplicadas" o "no_obvias" (siempre en estas tres palabras exactas, sin traducir, sin
  importar el idioma de esta instancia -- es un identificador interno, no texto para
  mostrar).
- IMPORTANTE - prohibido el gloss bilingüe: "titulo" nunca lleva una traducción entre
  paréntesis ni en ningún otro formato (mal: "Hydrostatics (Hidrostática)"; bien:
  "Hydrostatics"). Va SOLO en el idioma pedido, sin excepción.
- IMPORTANTE - filtro estricto de dominio: el sitio es EXCLUSIVAMENTE matemática,
  ciencias exactas/naturales, y aplicaciones cuantitativas serias de estas (ingeniería,
  economía cuantitativa, ciencias de la computación con base matemática, etc.).
  NO son temas válidos, aunque suenen "académicos": lengua/gramática (ej. "análisis
  sintáctico", "análisis morfológico"), literatura, historia, filosofía no-formal,
  arte, ciencias sociales sin componente cuantitativo, idiomas, derecho. Ante un
  término ambiguo por el nombre (ej. "análisis" a secas, que podría ser matemático o
  lingüístico), elegí la interpretación NO matemática solo si el término específico
  completo (no una palabra suelta) es inequívocamente de otra disciplina; si hay
  ambigüedad real, preferí devolver confianza="baja" con la interpretación matemática
  antes que aceptar algo fuera de dominio.
${hayCatalogo ? "" : bulletLogicaVieja}- Si el término no tiene relación clara con ninguna materia posible, o es
  ininteligible/spam/no académico, o es un tema real pero fuera de dominio (ver filtro
  estricto arriba), devolvé materia=null.
- IMPORTANTE: "no encaja en ninguna materia de la LISTA EXISTENTE" nunca es motivo por
  sí solo para devolver materia=null. Ese es exactamente el caso de esNueva=true (ver
  regla arriba). Devolvé materia=null ÚNICAMENTE cuando el término no es un tema válido
  de matemática/ciencia/aplicación cuantitativa en absoluto (spam, otra disciplina,
  ininteligible) - nunca porque "todavía no hay una materia creada para esto". Por
  ejemplo, si la lista de materias existentes es solo ["estadistica"] y el término es
  "geometría euclidiana", la respuesta correcta es esNueva=true con materia="geometria",
  NO materia=null: geometría es un tema real de matemática, solo que no está en la lista.
  Si devolvés materia=null con confianza="alta" para un término que en realidad es un
  tema real de matemática/ciencia, eso es un error grave del clasificador.

Formato de salida (JSON):
{
  "materia": "id_de_materia" | null,
  "esNueva": true | false,
  "titulo": "Título prolijo" | null,
  "grupo": "${esEspanol ? "Ciencias exactas" : "equivalente de Ciencias exactas en " + idioma}" | "${esEspanol ? "Ciencias aplicadas" : "equivalente de Ciencias aplicadas en " + idioma}" | "${esEspanol ? "Aplicaciones no obvias" : "equivalente de Aplicaciones no obvias en " + idioma}" | null,
  "grupoClave": "exactas" | "aplicadas" | "no_obvias" | null,
  "confianza": "alta" | "media" | "baja"
}
Si esNueva=false, "titulo", "grupo" y "grupoClave" van en null (no hace falta repetirlos).
Si "materia" es null, esNueva=false, "titulo", "grupo" y "grupoClave" también van en null.`;

  const lineasCatalogo = hayCatalogo
    ? catalogo.materias.map((m) => `- ${m.id} | ${m.titulo} | grupo: ${m.grupo || "-"} | temas: ${m.temas.slice(0, 15).map((t) => t.titulo).join("; ") || "(ninguno todavía)"}`).join("\n")
    : null;
  const prompt = hayCatalogo
    ? `Catálogo actual de materias en este idioma (id | título | grupo | temas que ya tiene):\n${lineasCatalogo}\n\nTérmino buscado por el usuario: "${termino}"`
    : `Materias que ya existen en este idioma: ${materias.join(", ")}

Término buscado por el usuario: "${termino}"`;

  return { system, prompt };
}
