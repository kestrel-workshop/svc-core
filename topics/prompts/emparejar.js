/**
 * Prompt que empareja los temas de una materia en un idioma con los temas "canónicos" (los del español).
 * locales    = [{ id, titulo }] temas de la materia en el idioma local
 * candidatos = [{ clave, titulo }] temas canónicos de la misma materia (títulos en español)
 */
export function armarPromptEmparejar(locales, candidatos, idioma) {
  const system = `Sos quien empareja temas de una biblioteca de matemática y ciencias entre idiomas.
Tu única salida es JSON válido, sin texto antes ni después, sin markdown fences.

Te doy los temas de UNA materia en el idioma "${idioma}" y los temas de la misma materia en español (la lista
canónica). Para cada tema del idioma "${idioma}" decí a qué tema de la lista canónica corresponde: es el MISMO tema,
traducido (no uno parecido ni uno relacionado). Reglas:
  * Usá exactamente la "clave" de la lista canónica (el texto antes de la barra "|").
  * Cada clave canónica se usa como máximo una vez.
  * Si un tema del idioma "${idioma}" no tiene equivalente claro en la lista canónica, ponele null. Es mejor null que
    adivinar.

Formato de salida:
{ "pares": { "<id del tema en ${idioma}>": "<clave canónica>" | null, ... } }`;

  const prompt =
    "Temas en el idioma \"" + idioma + "\" (id | título):\n" + locales.map((t) => `- ${t.id} | ${t.titulo}`).join("\n") +
    "\n\nLista canónica en español (clave | título):\n" + candidatos.map((c) => `- ${c.clave} | ${c.titulo}`).join("\n");
  return { system, prompt };
}
