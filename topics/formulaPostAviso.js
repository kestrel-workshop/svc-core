import "./env.js";
import { generarYGuardarJSON } from "../lib/generar.js";
import { trackJob } from "../lib/trabajo.js";
import { notifyDiscord } from "./lib/avisoDiscord.js";

export const formulaRetry = { delays: [2000, 5000, 15000, 30000] };

export async function generarFormulaConReintentos({ materia, tema, idioma = "es" }, generar = generarYGuardarJSON) {
  const label = `${materia} / ${tema} (${idioma})`;
  const maxAttempts = formulaRetry.delays.length + 1;
  let reason = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await trackJob("formula", `${materia} / ${tema}`, () =>
        generar({ materia, tema, tipos: ["formula"], idioma })
      );
      if (!result || result.ok !== false) {
        console.log(`[aviso-formula] ${label}: done`);
        return true;
      }
      reason = `partial errors: ${JSON.stringify(result.errores || result).slice(0, 300)}`;
    } catch (err) {
      reason = err.message;
    }
    if (attempt < maxAttempts) {
      const delay = formulaRetry.delays[attempt - 1];
      console.warn(`[aviso-formula] ${label}: ${reason}; retry ${attempt + 1}/${maxAttempts} in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  console.error(`[aviso-formula] gave up on ${label}: ${reason}`);
  await notifyDiscord(`The formula for \`${tema}\` (${materia}, ${idioma}) could not be generated after ${maxAttempts} attempts: ${reason}`);
  return false;
}
