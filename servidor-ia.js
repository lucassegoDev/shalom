// servidor-ia.js: backend mínimo para Shalom, usando Gemini (Google).
// Requiere Node.js 18 o superior. No hace falta instalar nada más.
// Uso en tu PC:  GEMINI_API_KEY=tu_clave node servidor-ia.js
// La clave queda en el servidor. Nunca va en el HTML de la app.

const http = require("http");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // al publicar, poné https://TUUSUARIO.github.io
const MAX_PREGUNTA = 500;
const MAX_CONSULTAS_HORA = 20; // por conexión, para no gastar de más

const SYSTEM_PROMPT = `
Sos "Shalom", una consejería cristiana evangélica pentecostal con voz de pastora: cálida, cercana, humilde y firme en la fe. Hablás en español rioplatense (voseo), con frases cortas y claras.

Qué sos y qué no sos:
- Sos una inteligencia artificial. No sos una persona ni una pastora real. Si te preguntan, lo decís con cariño.
- No reemplazás a la iglesia, a un pastor de carne y hueso, a un médico ni a un psicólogo. Animá a la persona a apoyarse en su comunidad de fe y en su familia.
- No pidas ofrendas, diezmos ni dinero.

El nombre de Dios:
- Nunca te presentes con el nombre de Dios, de Jesús, del Espíritu Santo ni de ninguna figura divina. No te atribuyas el lugar de Dios ni hables como si fueras su voz.
- Hablá de Dios con reverencia. No uses su nombre como exclamación ni de manera irrespetuosa.

Cómo aconsejar:
- Respondé con amor, sin juzgar ni culpar. Nunca presentes el ciclo menstrual, el dolor o el cansancio como castigo, pecado o falta de fe.
- Podés mencionar referencias bíblicas conocidas (libro, capítulo y versículo) y sugerir que la persona las lea en su Biblia. No escribas versículos completos ni los cites de memoria.
- Ofrecé una oración corta cuando sea oportuno.
- Respuestas breves: como máximo unos 6 renglones, más una referencia y, si corresponde, una oración.
- Si la persona está angustiada, primero acompañala con palabras de consuelo. Después, si hace falta, sugerí hablar con alguien de confianza.

Salud:
- No diagnostiques ni recetes. No digas que deje un tratamiento, un medicamento o una consulta médica por orar o por fe. Orar y consultar al médico no son opuestos: podés animar a orar por sanidad y, a la vez, a buscar atención médica.
- Ante dolor fuerte, sangrado abundante, fiebre, mareos o cualquier síntoma que la preocupe, recomendá consultar a un médico lo antes posible.
- No des consejos sobre dosis ni sobre cómo ocultar síntomas.

Límites de seguridad:
- Si la persona menciona pensamientos de suicidio o de hacerse daño, respondé con cuidado y de forma directa: pedile que hable ahora con alguien de confianza que esté con ella, y que llame al 911 o a una línea de asistencia en crisis (en Argentina, 911 o 107 para emergencias médicas). No sigas solo con consejos espirituales.
- Si la persona cuenta que sufre violencia, amenazas, control o abuso (de pareja o de cualquier persona), validá lo que vive y decí que no es su culpa y que no tiene que aguantarlo. Animala a buscar ayuda profesional y a alguien de confianza. Nunca le digas que tolere, se someta o perdone para sostener la relación.

Privacidad:
- Usá solo el resumen de datos que recibís. No pidas datos personales ni nombres.

Recordá: sos una consejería que acompaña. Tu objetivo es que la persona se sienta cuidada, que pueda acercarse a Dios y que busque ayuda real cuando la necesite.
`;

const MENSAJE_CRISIS = "Lo que contás es muy importante y no tenés que cargarlo sola. Por favor, buscá ahora a una persona de confianza que esté con vos. Si corrés peligro, llamá al 911 (Argentina). También podés comunicarte con una línea de asistencia en crisis de tu zona. Dios no quiere que pases esto sola, y merecés ayuda real hoy.";
const PALABRAS_CRISIS = /suicid|matarme|quitarme la vida|no quiero vivir|hacerme daño|lastimarme|autolesi/i;

const consultasPorIP = new Map();
function puedeConsultar(ip) {
  const ahora = Date.now();
  const recientes = (consultasPorIP.get(ip) || []).filter(t => ahora - t < 3600000);
  if (recientes.length >= MAX_CONSULTAS_HORA) {
    consultasPorIP.set(ip, recientes);
    return false;
  }
  recientes.push(ahora);
  consultasPorIP.set(ip, recientes);
  return true;
}

function enviarJSON(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(code === 204 ? "" : JSON.stringify(obj));
}

function leerBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => {
      data += c;
      if (data.length > 10000) {
        req.destroy();
        reject(new Error("Pedido demasiado grande"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sanitizarResumen(r) {
  if (!r || typeof r !== "object") return null;
  return {
    fase: String(r.fase || "").slice(0, 40),
    dia_del_ciclo: Number(r.dia_del_ciclo) || null,
    duracion_promedio_ciclo: Number(r.duracion_promedio_ciclo) || null,
  };
}

async function preguntarGemini(pregunta, resumen) {
  const contexto = resumen
    ? `Datos resumidos de la usuaria: fase "${resumen.fase}", día ${resumen.dia_del_ciclo} del ciclo, duración promedio ${resumen.duracion_promedio_ciclo} días.`
    : "No hay datos de ciclo registrados.";

  // La clave va en la dirección (?key=). Nunca la mostramos en los mensajes de error.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: `${contexto}\n\nPregunta: ${pregunta}` }] }],
      generationConfig: { maxOutputTokens: 400 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini respondió ${r.status}`);

  const j = await r.json();
  const partes = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  return partes.map(p => p.text || "").join("\n").trim();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return enviarJSON(res, 204, {});
  if (req.method !== "POST" || req.url !== "/preguntar") {
    return enviarJSON(res, 404, { error: "No encontrado" });
  }

  if (!puedeConsultar(req.socket.remoteAddress)) {
    return enviarJSON(res, 429, { error: "Hiciste muchas consultas seguidas. Probá más tarde." });
  }

  let body;
  try {
    body = JSON.parse(await leerBody(req));
  } catch {
    return enviarJSON(res, 400, { error: "Pedido inválido" });
  }

  const pregunta = typeof body.pregunta === "string" ? body.pregunta.trim() : "";
  if (!pregunta || pregunta.length > MAX_PREGUNTA) {
    return enviarJSON(res, 400, { error: `La pregunta tiene que tener entre 1 y ${MAX_PREGUNTA} caracteres.` });
  }

  if (PALABRAS_CRISIS.test(pregunta)) {
    return enviarJSON(res, 200, { respuesta: MENSAJE_CRISIS });
  }

  if (!API_KEY) {
    return enviarJSON(res, 500, { error: "Al servidor le falta GEMINI_API_KEY." });
  }

  try {
    const respuesta = await preguntarGemini(pregunta, sanitizarResumen(body.resumen));
    if (!respuesta) throw new Error("Respuesta vacía");
    enviarJSON(res, 200, { respuesta });
  } catch (err) {
    console.error(err.message);
    enviarJSON(res, 502, { error: "No pude responder ahora." });
  }
});

if (!API_KEY) console.warn("Aviso: falta GEMINI_API_KEY. El servidor arranca, pero no va a responder.");
server.listen(PORT, () => console.log(`Shalom IA escuchando en http://localhost:${PORT}/preguntar`));
