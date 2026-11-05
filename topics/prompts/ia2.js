/**
 * Arma el prompt de IA #2: valida si el término buscado es un tema real
 * de la materia, chequea si ya existe (con otro nombre) usando la lista
 * de temas ya cargados en KV, y decide qué moldePractica corresponde.
 *
 * temasExistentes = array de {titulo} ya en <materia>.json (KV)
 * idioma = código ISO del idioma DESTINO (ej. "es", "en", "pt"); default
 * "es" para no romper llamados viejos que no lo manden. Server.js ya
 * pasa este 4to argumento hace rato -- antes esta función solo tenía 3
 * parámetros y JS lo descartaba en silencio, sin error.
 *
 * esMateriaNueva = true cuando "materia" todavía NO existe y se está
 * creando recién a partir de este mismo terminoBuscado (clasificacion.esNueva
 * en server.js). Ver FIX 19/09 más abajo.
 *
 * FIX (números complejos en japonés -- 19/09): cuando la materia es nueva,
 * temasExistentes siempre viene vacío, y el término buscado ES, casi
 * siempre, el tema fundacional de esa materia (ej: termino="números
 * complejos", materia nueva="numeros_complejos"). El punto 1 de abajo le
 * pedía a IA#2 que confirme que el término es un tema "específico" DENTRO
 * de la materia -- para una materia que se está fundando con ese mismo
 * término, esa pregunta es circular (le estás preguntando si el tema es un
 * subtema de sí mismo) y termina rechazando propuestas de materia nueva
 * válidas por "no ser específicas", incluso cuando clasificarYValidarConReintento
 * ya hizo el trabajo de proponer una materia nueva razonable. Con
 * esMateriaNueva=true relajamos ese punto: alcanza con que sea un tema real
 * que amerite fundar su propia materia, no que sea puntual dentro de una
 * biblioteca ya poblada.
 */
export function armarPromptIA2(materia, terminoBuscado, temasExistentes, idioma = "es", esMateriaNueva = false) {
  const listaTemas = (temasExistentes || []).map((t) => `- ${t.titulo}`).join("\n") || "(ninguno todavía)";

  const avisoMateriaNueva = esMateriaNueva
    ? `\n\nIMPORTANTE: "${materia}" es una materia NUEVA que se está creando recién ahora, a partir de\neste mismo término -- por eso no tiene ningún tema cargado todavía (ver lista abajo, vacía).\nNo la trates como si fuera una biblioteca ya poblada: es esperable, y está BIEN, que el término\nbuscado sea el tema fundacional/raíz de la materia entera (ej: término "números complejos" para\nfundar la materia "numeros_complejos"). No lo rechaces solo por ser "demasiado general" o por\n"no ser un subtema específico" -- para eso alcanza con que sea un tema real de\nmatemática/ciencias/aplicaciones cuantitativas que amerite tener su propia materia.`
    : "";

  const system = `Sos el validador de temas nuevos para una biblioteca de fórmulas universal, materia "${materia}".
Tu única salida es JSON válido, sin texto antes ni después, sin markdown fences.

IDIOMA DE SALIDA: "tituloNormalizado", "notas" y "razon" tenés que escribirlos en el idioma con
código ISO "${idioma}" (si es "es", en español). Esto aplica al TEXTO que generás vos, no a los
nombres de los campos del JSON (que quedan igual siempre).${avisoMateriaNueva}

Un usuario buscó un término que no se encontró en la biblioteca. Tenés que decidir:

1. ¿Es un tema real${esMateriaNueva ? "" : " y específico"} de "${materia}"? (no aceptar términos vagos, mal escritos sin
   sentido, insultos, o temas de otra materia). Recordá que el sitio es exclusivamente
   matemática/ciencias/aplicaciones cuantitativas: si el término es en realidad de otra
   disciplina (lengua, literatura, historia, etc.) y llegó hasta acá por error de
   clasificación, marcalo esValido=false igual, aunque técnicamente "encajara" en el nombre
   de la materia "${materia}".
   No rechaces un término solo porque no lo reconozcas: si es un objeto matemático o científico con
   nombre propio conocido (una distribución, un teorema, un método, una ley), es un tema real.
2. ¿Ya existe con otro nombre en la lista de temas actuales? Si el término buscado es sinónimo, variante
   de redacción, o un caso particular de un tema ya existente, marcalo como duplicado y decí cuál es el
   tema existente equivalente.
3. Si es un tema nuevo y válido, elegí qué molde de práctica le corresponde:
   - "modelo1": la figura es NECESARIA para resolver al menos un ejercicio (sin verla no se puede
     resolver ese ejercicio). Se usa para temas donde hace falta ver una figura concreta con datos
     marcados (ej: un triángulo con catetos etiquetados, un circuito, un diagrama de cuerpo libre).
   - "modelo2": la figura es un EXTRA que ayuda a visualizar pero no es necesaria (todos los ejercicios
     se pueden resolver solo con el texto/los datos numéricos). Se usa para temas con componente
     gráfica/geométrica pero donde la figura es solo de referencia (ej: polígonos regulares con el
     radio dado en el enunciado).

Temas que ya existen en "${materia}":
${listaTemas}

Formato de salida (JSON):
{
  "esValido": true | false,
  "esDuplicado": true | false,
  "tituloExistenteEquivalente": "título exacto del tema ya existente si esDuplicado=true, si no null",
  "tituloNormalizado": "título prolijo y bien escrito del tema, en el idioma \\"${idioma}\\", listo para mostrar (ej: 'Ecuaciones lineales' en español, 'Linear equations' en inglés). Null si esValido=false.",
  "moldePractica": "modelo1" | "modelo2" | null,
  "notas": "1-2 líneas en el idioma \\"${idioma}\\" con contexto/alcance del tema, para pasarle a IA #3 como guía. Null si no aplica.",
  "razon": "si esValido=false o esDuplicado=true, breve explicación en el idioma \\"${idioma}\\" de por qué"
}`;

  const prompt = `Término buscado por el usuario: "${terminoBuscado}"`;

  return { system, prompt };
}
