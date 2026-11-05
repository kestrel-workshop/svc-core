import { agregarTemaAMateria } from "./actualizarJson.js";
import { calcularDificultadYRequisitos, difficultyDiagnostics } from "./dificultad.js";
import { registrarTemaNuevo } from "./organizacion.js";
import { slugify } from "./slugify.js";
import { notifyDiscord } from "./avisoDiscord.js";
import { markGraphDirty } from "../graph/store.js";

export const difficultyRetry = { delays: [3000, 8000] };

async function difficultyWithRetry({ tema, materia, idioma }) {
  let result = await calcularDificultadYRequisitos({ tema, materia, idioma });
  const errors = [difficultyDiagnostics.lastError];
  for (const delay of difficultyRetry.delays) {
    if (result && Number.isInteger(result.nivel)) return { result, errors: [] };
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = await calcularDificultadYRequisitos({ tema, materia, idioma });
    errors.push(difficultyDiagnostics.lastError);
  }
  return { result: result || {}, errors: Number.isInteger(result && result.nivel) ? [] : errors };
}

export async function registerTopic({ materia, tema, materiaNuevaInfo = null, idioma = "es" }) {
  const { result: extraTema, errors } = await difficultyWithRetry({ tema, materia, idioma });
  if (!Number.isInteger(extraTema.nivel)) {
    const reasons = errors.filter(Boolean).map((e, i) => `#${i + 1}: ${e}`).join(" | ") || "no error captured";
    notifyDiscord(`Topic \`${tema}\` (${materia}, ${idioma}) was published WITHOUT level/difficulty after retries. Reason: ${reasons}. Fix with POST /rellenar-dificultad?nivel=1.`);
  }
  const resultadoKV = await agregarTemaAMateria(materia, tema, materiaNuevaInfo, idioma, extraTema);
  await registrarTemaNuevo({ idioma, materia, id: slugify(tema.trim()), titulo: tema, extra: extraTema });
  markGraphDirty();
  return resultadoKV;
}
