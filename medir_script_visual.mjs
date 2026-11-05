import { generarScriptVisual } from "./lib/scriptVisual.js";

const PRICES = { "claude-fable-5-1": [10, 50], "claude-opus-4-8": [5, 25], "claude-opus-5-5": [5, 25] };

const TOPICS = [
  ["calculo_diferencial", "Derivadas"],
  ["algebra_lineal", "Autovalores y autovectores"],
  ["fisica_ondas", "Interferencia de ondas"],
  ["probabilidad", "Distribución normal"],
  ["mecanica_clasica", "Movimiento de un proyectil"],
  ["geometria_analitica", "Secciones cónicas"],
];

const only = process.argv[2] ? Number(process.argv[2]) : TOPICS.length;
const rows = [];

for (const [materia, tema] of TOPICS.slice(0, only)) {
  const usages = [];
  const started = Date.now();
  try {
    const { script } = await generarScriptVisual(materia, tema, "es", { onUsage: (u) => usages.push(u) });
    const tin = usages.reduce((a, u) => a + (u.input_tokens || 0), 0);
    const tout = usages.reduce((a, u) => a + (u.output_tokens || 0), 0);
    const cost = usages.reduce((a, u) => {
      const [pin, pout] = PRICES[u.model] || [10, 50];
      return a + ((u.input_tokens || 0) * pin + (u.output_tokens || 0) * pout) / 1e6;
    }, 0);
    rows.push({ tema, intentos: usages.length, chars: script.length, tin, tout, usd: Number(cost.toFixed(4)), seg: Math.round((Date.now() - started) / 1000) });
  } catch (err) {
    rows.push({ tema, intentos: usages.length, error: String(err.message).slice(0, 120) });
  }
}

console.table(rows);
const ok = rows.filter((r) => !r.error);
if (ok.length) {
  const avg = (k) => Math.round(ok.reduce((a, r) => a + r[k], 0) / ok.length);
  console.log(`promedio: ${avg("tin")} tokens de entrada, ${avg("tout")} de salida, ${avg("chars")} caracteres, ${(ok.reduce((a, r) => a + r.usd, 0) / ok.length).toFixed(4)} USD por script`);
  console.log(`máximo de salida: ${Math.max(...ok.map((r) => r.tout))} tokens (tope configurado: 10000)`);
}
