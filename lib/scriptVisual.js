import vm from "node:vm";
import { llamarIA, esRechazoDelModelo } from "./claude.js";

export const MAX_SCRIPT_CHARS = 20000;
export const MIN_SCRIPT_CHARS = 300;
const MAX_TOKENS_SCRIPT = 10000;
const MAX_ATTEMPTS = 3;
const DRY_RUN_TIMEOUT_MS = 1500;

const MODEL = process.env.MODELO_VISUAL || "claude-fable-5-1";
const FALLBACK_MODEL = process.env.MODELO_VISUAL_RESPALDO || "claude-opus-4-8";

const FORBIDDEN_PATTERNS = [
  /\bfetch\s*\(/i, /XMLHttpRequest/i, /\bWebSocket\b/i, /\beval\s*\(/i,
  /new\s+Function\s*\(/i, /\bdocument\b/i, /\bwindow\b/i, /\bself\b/i,
  /\bnavigator\b/i, /postMessage/i, /importScripts/i,
  /\blocation\s*[.=\[]/i, /\.\s*location\b/i,
  /RTCPeerConnection/i, /RTCDataChannel/i,
  /\.\s*(fetch|eval|constructor|document|window|self|top|parent|postMessage|require)\b/i,
];

const LANGUAGE_NAMES = {
  es: "Spanish", en: "English", ja: "Japanese", zh: "Chinese", ko: "Korean", de: "German",
  pt: "Portuguese", fr: "French", ru: "Russian", ar: "Arabic", hi: "Hindi", id: "Indonesian",
};

const SYSTEM_PROMPT = `You write a self-contained JavaScript animation that teaches one mathematics, science or engineering topic.
The script runs in a sandboxed browser canvas. Reply only by calling the tool with the full source in "script".

RUNTIME CONTRACT
- Define a global function animateScene(scene, t). It is called every frame. t is the clock in milliseconds.
- Optionally define a global number DURATION (milliseconds). If present, t loops in [0, DURATION) and the player shows a time bar with pause, seek and speed. Make every motion periodic in DURATION so the loop has no jump. Use 8000 to 20000.
- Everything that moves must be a pure function of t, never of accumulated state, so that seeking and pausing work.
- There is no DOM, no network, no timers, no imports. Never use document, window, self, fetch, eval, Function, setTimeout, requestAnimationFrame, location, navigator, constructor, postMessage.
- Only plain ES2017 JavaScript and Math.

scene API (canvas coordinates in CSS pixels, origin top-left)
- scene.width, scene.height
- scene.clear()
- scene.drawRectangle(x, y, w, h, color)            filled
- scene.drawCircle(x, y, r, color)                  filled
- scene.drawLine(x1, y1, x2, y2, color, lineWidth)
- scene.drawPolyline(points, color, lineWidth)      points = [[x, y], ...]
- scene.fillPolygon(points, color)
- scene.drawText(text, x, y, size, color, align, baseline)   align: left|center|right, baseline: alphabetic|middle|top|bottom
- scene.measureText(text, size) -> width in pixels
- scene.mouse: { x, y, down, inside, clicked }       optional interaction
- scene.keys.down(name), scene.keys.pressed(name)   optional

Colors are CSS strings. Background is dark: start every frame with scene.clear() and a dark drawRectangle (for example #0b0e14), then use light, high-contrast colors.

QUALITY RULES
- Show the mechanism of the topic, not a poster. The viewer should understand the key relation by watching what changes and what stays fixed.
- Draw axes, curves or objects with the real mathematics of the topic (compute the actual function, do not fake it).
- Label what matters with drawText: variable names, key values that update with t, and a short title. All visible words are written in the language requested by the user message; symbols and numbers stay as they are.
- Lay out from scene.width and scene.height so it works from 320 px to 1600 px wide. Scale font sizes with the smaller dimension (for example Math.max(11, Math.min(w, h) * 0.035)). Keep text inside the canvas.
- Prefer one clear scene over many panels. Optionally let scene.mouse change a parameter (drag a point, hover to read a value) when it helps, and always keep a sensible default when there is no mouse.
- Keep the code compact: under ${MAX_SCRIPT_CHARS} characters, no comments, no dead code, no unbounded loops (at most a few thousand iterations per frame).

MINIMAL EXAMPLE (structure only)
var DURATION = 10000;
function animateScene(scene, t) {
  var w = scene.width, h = scene.height, u = t / DURATION;
  scene.clear();
  scene.drawRectangle(0, 0, w, h, "#0b0e14");
  var pts = [];
  for (var i = 0; i <= 120; i++) { var x = i / 120; pts.push([w * 0.1 + w * 0.8 * x, h * 0.5 - h * 0.3 * Math.sin(2 * Math.PI * (x * 2 - u))]); }
  scene.drawPolyline(pts, "#7fd0e8", 2.5);
  scene.drawText("y = sin(2π(2x − t))", w * 0.1, h * 0.12, Math.max(12, Math.min(w, h) * 0.04), "#e8eefc", "left", "middle");
}`;

export function armarPromptScript(materia, tema, idioma = "es") {
  const language = LANGUAGE_NAMES[idioma] || "Spanish";
  return {
    system: SYSTEM_PROMPT,
    prompt: `Subject: ${materia}\nTopic: ${tema}\nLanguage for every visible word: ${language}\n\nWrite the animation script for this topic.`,
  };
}

export function armarToolScript() {
  return {
    name: "guardar_script_visual",
    description: "Returns the complete JavaScript source of the animation.",
    input_schema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Full JavaScript source defining animateScene(scene, t) and optionally DURATION." },
      },
      required: ["script"],
    },
  };
}

function makeStubScene(width, height, drawn) {
  const count = (name) => (...args) => { drawn[name] = (drawn[name] || 0) + 1; drawn.total += 1; return name === "measureText" ? String(args[0] ?? "").length * 7 : undefined; };
  return {
    width,
    height,
    ancho: width,
    alto: height,
    clear: count("clear"),
    drawCircle: count("drawCircle"),
    drawRectangle: count("drawRectangle"),
    drawLine: count("drawLine"),
    drawPolyline: count("drawPolyline"),
    fillPolygon: count("fillPolygon"),
    drawText: count("drawText"),
    measureText: count("measureText"),
    mouse: { x: width / 2, y: height / 2, down: false, inside: true, clicked: false, dx: 0, dy: 0, locked: false, lock() {}, unlock() {} },
    keys: { down: () => false, pressed: () => false },
  };
}

export function validarScript(script) {
  const errors = [];
  if (typeof script !== "string") return { ok: false, errors: ["script is not a string"] };
  const code = script.trim();
  if (code.length < MIN_SCRIPT_CHARS) errors.push(`script is too short (${code.length} chars)`);
  if (code.length > MAX_SCRIPT_CHARS) errors.push(`script is too long (${code.length} > ${MAX_SCRIPT_CHARS} chars)`);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) errors.push(`forbidden pattern ${pattern}`);
  }
  if (!/function\s+animateScene\s*\(/.test(code) && !/animateScene\s*=/.test(code)) errors.push("animateScene is not defined");
  if (errors.length > 0) return { ok: false, errors };

  let compiled;
  try {
    compiled = new vm.Script(`${code}\n;({ animateScene: typeof animateScene === "function" ? animateScene : null, duration: typeof DURATION === "number" ? DURATION : 0 })`);
  } catch (err) {
    return { ok: false, errors: [`syntax error: ${err.message}`] };
  }

  const probes = [[800, 450], [360, 640], [1400, 700]];
  for (const [width, height] of probes) {
    const drawn = { total: 0 };
    const sandbox = Object.create(null);
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    let exported;
    try {
      exported = compiled.runInContext(context, { timeout: DRY_RUN_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, errors: [`top-level error: ${err.message}`] };
    }
    if (!exported || typeof exported.animateScene !== "function") return { ok: false, errors: ["animateScene is not a function"] };
    const duration = exported.duration > 0 ? exported.duration : 10000;
    const scene = makeStubScene(width, height, drawn);
    context.__animate = exported.animateScene;
    context.__scene = scene;
    for (const fraction of [0, 0.25, 0.5, 0.75, 0.999]) {
      context.__t = Math.floor(duration * fraction);
      try {
        new vm.Script("__animate(__scene, __t)").runInContext(context, { timeout: DRY_RUN_TIMEOUT_MS });
      } catch (err) {
        return { ok: false, errors: [`animateScene failed at ${width}x${height}, t=${context.__t}: ${err.message}`] };
      }
    }
    if (drawn.total < 5) return { ok: false, errors: [`animateScene draws almost nothing (${drawn.total} calls)`] };
    if (!drawn.drawText) return { ok: false, errors: ["animateScene never calls drawText, so nothing is labeled"] };
  }

  return { ok: true, errors: [] };
}

export async function generarScriptVisual(materia, tema, idioma = "es", { llamar = llamarIA, onUsage = null } = {}) {
  const { system, prompt } = armarPromptScript(materia, tema, idioma);
  const tool = armarToolScript();
  let model = MODEL;
  let lastError;
  let feedback = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[generar-json] visual: ${model} writes the script for "${materia} / ${tema}", attempt ${attempt}/${MAX_ATTEMPTS}`);
    try {
      const result = await llamar({
        system,
        prompt: prompt + feedback,
        model,
        maxTokens: MAX_TOKENS_SCRIPT,
        tool,
        concepto: "generador-json-script",
        onUsage: (usage) => {
          console.log(`[generar-json] script: tokens in=${usage.input_tokens ?? "?"} out=${usage.output_tokens ?? "?"} (${model}, stop=${usage.stopReason})`);
          if (onUsage) onUsage(usage);
        },
      });
      const script = typeof result?.script === "string" ? result.script.trim() : result?.script;
      const check = validarScript(script);
      if (check.ok) {
        console.log(`[generar-json] script: ${script.length} chars, valid at attempt ${attempt}`);
        return { script };
      }
      lastError = new Error(`invalid script: ${check.errors.join("; ")}`);
      feedback = `\n\nYour previous attempt was rejected: ${check.errors.join("; ")}. Fix it and return the complete script again.`;
      console.warn(`[generar-json] visual: attempt ${attempt} rejected (${lastError.message.slice(0, 300)})`);
    } catch (err) {
      lastError = err;
      if (esRechazoDelModelo(err) && model !== FALLBACK_MODEL) {
        console.warn(`[generar-json] visual: ${model} refused, continuing with ${FALLBACK_MODEL}`);
        model = FALLBACK_MODEL;
        continue;
      }
      console.warn(`[generar-json] visual: attempt ${attempt} failed (${String(err.message).slice(0, 200)})`);
    }
  }

  throw new Error(`[generar-json] visual: no valid script after ${MAX_ATTEMPTS} attempts. Last error: ${lastError?.message}`);
}
