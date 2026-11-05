import { validarVisual, validarVeredictoVisual, validarDictamenVisual, veredictoDelJuezVisual } from "./lib/validarEstructura.js";
import { armarToolClaude, armarToolCorreccion, armarPromptClaude, armarToolJuezVisual, armarPromptJuezVisual } from "./prompts/prompts.js";

let fallos = 0;
const check = (nombre, cond, extra) => {
  console.log((cond ? "OK   " : "FALLA") + " " + nombre + (extra ? "  " + extra : ""));
  if (!cond) fallos++;
};

const crear = armarToolClaude("visual");
const corregir = armarToolCorreccion("visual");
check("creación: 'veredicto' es la primera propiedad y obligatoria", Object.keys(crear.input_schema.properties)[0] === "veredicto" && JSON.stringify(crear.input_schema.required) === JSON.stringify(["veredicto"]));
check("creación: el veredicto solo admite grafica_bien | reservar", JSON.stringify(crear.input_schema.properties.veredicto.enum) === JSON.stringify(["grafica_bien", "reservar"]));
check("creación: no hay campos de texto libre para mejoras", !("analisis" in crear.input_schema.properties) && !("necesitaHerramienta" in crear.input_schema.properties));
check("corrección: no lleva 'veredicto'", !("veredicto" in corregir.input_schema.properties));
check("corrección: lleva 'revision_matematica' primero", Object.keys(corregir.input_schema.properties)[0] === "revision_matematica");

const juez = armarToolJuezVisual();
check("juez: solo 'veredicto' positivo | negativo", JSON.stringify(Object.keys(juez.input_schema.properties)) === JSON.stringify(["veredicto"]) && JSON.stringify(juez.input_schema.properties.veredicto.enum) === JSON.stringify(["positivo", "negativo"]));
const pj = armarPromptJuezVisual("Física", "Hidrostática");
check("juez: el prompt no pide explicaciones y es ciego", /sin ninguna explicación/.test(pj.system) && pj.prompt === "Materia: Física\nTema: Hidrostática");
check("creador: el prompt habla de 'veredicto' y no de 'necesitaHerramienta'", !/necesitaHerramienta/.test(armarPromptClaude("visual", "Física", "Hidrostática").system) && /veredicto/.test(armarPromptClaude("visual", "Física", "Hidrostática").system));

check("validarVeredicto: grafica_bien con fórmulas", validarVeredictoVisual({ veredicto: "grafica_bien", formulas: [{ formula: "x^2" }] }).ok);
check("validarVeredicto: reservar sin fórmulas", validarVeredictoVisual({ veredicto: "reservar" }).ok);
check("validarVeredicto: reservar con fórmulas falla", !validarVeredictoVisual({ veredicto: "reservar", formulas: [{ formula: "x^2" }] }).ok);
check("validarVeredicto: grafica_bien sin fórmulas falla", !validarVeredictoVisual({ veredicto: "grafica_bien" }).ok);
check("validarVeredicto: veredicto desconocido falla", !validarVeredictoVisual({ veredicto: "tal vez", formulas: [] }).ok);
check("validarVisual: reservar sin fórmulas es válido", validarVisual({ veredicto: "reservar" }).ok);
check("validarVisual: fórmulas normales siguen validando", validarVisual({ formulas: [{ formula: "sin(x)" }] }).ok);

check("dictamen: positivo", validarDictamenVisual({ veredicto: "positivo" }).ok && veredictoDelJuezVisual({ veredicto: "positivo" }) === "aprobar");
check("dictamen: negativo reserva", validarDictamenVisual({ veredicto: "negativo" }).ok && veredictoDelJuezVisual({ veredicto: "negativo" }) === "reservar");
check("dictamen: valor inválido se rechaza", !validarDictamenVisual({ veredicto: "enorme" }).ok && !validarDictamenVisual(null).ok);

if (fallos > 0) { console.log(`\n${fallos} comprobación(es) fallaron.`); process.exit(1); }
console.log("\nTodo bien.");
