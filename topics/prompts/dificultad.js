/**
 * Prompt que asigna a un tema su dificultad y los temas que hacen falta saber antes.
 *
 * temas = [{ id, titulo, materia }] a evaluar (uno solo al crear un tema; varios en el relleno).
 * catalogo = salida de cargarCatalogo(): sirve para listar TODOS los temas candidatos a prerrequisito,
 *            también los de otras materias (Derivadas sirve para Cinemática, por ejemplo).
 *
 * La IA devuelve un "puntaje" de 0 a 100 (más fino que un 1-5, que tiende a irse al medio) y el código lo
 * convierte en nivel 1-5 (ver lib/dificultad.js: nivelPorPuntaje / repartirNiveles).
 *
 * "requiere" lleva ids de tema (el slug), no "materia/tema": un tema vive en UNA sola materia y los ids no
 * se repiten, así que el vínculo no se rompe si una reorganización mueve el tema de materia.
 */
export function armarPromptDificultad(temas, catalogo, idioma = "es") {
  const lista = (catalogo?.materias || [])
    .map((m) => `## ${m.titulo} (${m.id})\n` + m.temas.map((t) => `- ${t.id} | ${t.titulo}${t.nivel ? ` | n${t.nivel}` : ""}`).join("\n"))
    .join("\n\n");

  const system = `Sos quien ordena una biblioteca de matemática y ciencias por dificultad y por orden de estudio.
Tu única salida es JSON válido, sin texto antes ni después, sin markdown fences.

Para cada tema que te pidan devolvé:

1) "puntaje": número entero de 0 a 100 con la dificultad del tema para un estudiante universitario de primer año.
   Usá estas anclas (son ejemplos de referencia, no una lista cerrada):
     0-20   Muy básico. Se entiende con aritmética y álgebra de secundaria.
            Ej: operar con fracciones, resolver una ecuación lineal, el teorema de Pitágoras.
     20-40  Básico. Una sola idea, pasos rutinarios, casi sin prerrequisitos.
            Ej: derivar un polinomio, la ley de Ohm, media y mediana, la ecuación de una recta.
     40-60  Intermedio. Hay que combinar varios conceptos previos.
            Ej: regla de la cadena, integración por partes, sistemas de ecuaciones lineales, leyes de Newton con rozamiento.
     60-80  Difícil. Abstracto o con muchos pasos encadenados.
            Ej: independencia lineal y bases, series de potencias, contraste de hipótesis, equilibrio químico.
     80-100 Muy difícil. Muy abstracto o técnico; suele trabar incluso a quien estudió.
            Ej: diagonalización y formas canónicas, ecuaciones diferenciales en derivadas parciales, mecánica cuántica.
   Reglas para repartir bien:
     * Comparalo contra TODO el catálogo de abajo (todas las materias), no solo contra los temas de su materia.
     * Usá toda la escala. En un catálogo de unos 90 temas de primer año se espera aproximadamente: 10 % en
       0-20, 25 % en 20-40, 30 % en 40-60, 25 % en 60-80 y 10 % en 80-100. No amontones todo en 40-60.
     * Un tema que viene después de otros (que lo requieren) casi siempre es más difícil que ellos.
     * Si dudás entre dos rangos, elegí el que tiene en cuenta cuántos temas previos hacen falta.

2) "nivel": entero de 1 a 7 que ubica el tema en una escala general de todo el catálogo (no solo de primer año).
   Las anclas son temas de referencia; comparalo contra ellas ("¿es más difícil que el ancla del nivel 4? ¿y que la del 5?")
   y elegí el nivel de la ancla más cercana:
     1 Base           Números reales e intervalos, Magnitudes, unidades y cifras significativas, Teorema de Pitágoras.
     2 Inicial        Funciones elementales, Vectores y operaciones, Media, mediana y moda.
     3 Introductorio  Derivadas, Matrices y operaciones, Leyes de Newton, Probabilidad básica y condicional.
     4 Intermedio     Integración por partes, Determinantes, Sistemas de ecuaciones lineales, Distribución normal.
     5 Avanzado       Series de potencias y de Taylor, Transformaciones lineales, Teorema central del límite, Contraste de hipótesis.
     6 Superior       Ecuaciones diferenciales lineales de segundo orden, Autovalores y autovectores, Multiplicadores de Lagrange, Series de Fourier.
     7 Especializado  Sistemas de ecuaciones diferenciales, Descomposición en valores singulares, Retropropagación, Ecuaciones de Navier-Stokes.
   Reglas: si el catálogo de abajo ya muestra el nivel de un tema (n1 a n7), usalo como referencia; un tema nunca va en un nivel
   menor que el de los temas que requiere.

3) "requiere": lista de ids (el texto antes de la barra "|") de los temas del catálogo que hay que saber
   ANTES de estudiar este. Reglas:
     * Solo prerrequisitos directos y conceptuales, entre 0 y 5. No pongas toda la cadena hacia atrás.
     * Solo ids que existan en el catálogo de abajo; nunca inventes uno ni pongas el propio tema.
     * Pueden ser de otra materia si de verdad hace falta (ej: Derivadas para Cinemática).
     * Un tema base (sin nada previo en el catálogo) lleva lista vacía.
     * No puede haber ciclos: si A requiere B, B no requiere A ni directa ni indirectamente.

El idioma de los títulos del catálogo es "${idioma}"; los ids y los nombres de los campos no cambian.

Catálogo (id | título | nivel si ya lo tiene):
${lista}

Formato de salida:
{ "temas": { "<id del tema evaluado>": { "puntaje": 0-100, "nivel": 1-7, "requiere": ["<id>", ...] }, ... } }`;

  const prompt = "Temas a evaluar (id | título | materia):\n" + temas.map((t) => `- ${t.id} | ${t.titulo} | ${t.materia}`).join("\n");
  return { system, prompt };
}
