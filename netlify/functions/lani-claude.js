const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MAX_HISTORY = 20;
const SUMMARY_THRESHOLD = 10;
const TIMEOUT_MS = 20000;

const ESCALATION_KEYWORDS = [
  "emergency", "urgente", "urgent", "problema grave", "accidente",
  "robo", "theft", "stolen", "fire", "fuego", "incendio",
  "queja", "complaint", "demand", "lawsuit", "legal",
  "hurt", "herido", "injured", "ambulance", "ambulancia",
  "police", "policia", "help me", "ayúdame", "ayudame"
];

function detectEscalation(message) {
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some(keyword => lower.includes(keyword));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), ms)
    )
  ]);
}

async function summarizeHistory(messages, systemPrompt) {
  const summaryPrompt = `Summarize this conversation in 3-4 sentences, keeping key details like names, dates, room preferences, and any issues mentioned:\n\n${messages.map(m => `${m.role}: ${m.content}`).join("\n")}`;

  const response = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: summaryPrompt }]
    })
  });

  const data = await response.json();
  return data.content?.[0]?.text || "";
}

// ─────────────────────────────────────────────────────────────────
// DETECCIÓN INTELIGENTE DE PROPIEDAD
// ─────────────────────────────────────────────────────────────────
async function detectPropertyFromMessage(userMessage, propertiesList) {
  const propertiesText = propertiesList.map((p, i) =>
    `${i + 1}. property_id: "${p.property_id}" | name: "${p.name}" | location: "${p.location || ""}"`
  ).join("\n");

  const detectionPrompt = `You are helping identify which property a guest wants to contact based on their message.

Available properties:
${propertiesText}

Guest message: "${userMessage}"

Your job is to match the guest's message to one of the properties above. Be flexible and intelligent:

NAME MATCHING:
- Match partial names: "frederick hotel" → property named "Frederick"
- Match with typos or spelling variations: "frederik", "frederic", "bay lantern" → match closest property
- Match nicknames or shortened names

NUMBER SELECTION:
- If the guest writes just a number like "1", "2", "3" → match to that numbered property in the list above
- "1" → first property in the list, "2" → second property, etc.

LOCATION MATCHING (handle any language and variation):
- "USA", "United States", "Estados Unidos", "EUA", "EEUU", "America", "Norteamerica" → all mean United States
- "Filipinas", "Philippines", "Pilipinas", "Pinas", "PH" → all mean Philippines
- "México", "Mexico", "Mex" → all mean Mexico
- Apply the same multilingual logic to ANY country mentioned
- City names also count: "San Francisco", "Manila", "Siargao", "Palawan", etc.
- If guest says "hoteles en X" or "hotel in X" or "algo en X" — treat X as a location filter

DECISION RULES:
- If location or name matches exactly ONE property → return that property_id
- If the guest wrote a number → return the property_id at that position in the list
- If location matches MULTIPLE properties → return "LOCATION_MULTIPLE:[the location term the guest used, as-is]"
- If message has no useful hints → return "NONE"
- If hints exist but match multiple and no location → return "AMBIGUOUS"

Respond ONLY with one of:
- The exact property_id (e.g. "frederick")
- "AMBIGUOUS"
- "NONE"
- "LOCATION_MULTIPLE:USA" (use whatever location term the guest actually wrote)

No explanation. No punctuation. No other text.`;

  const response = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 50,
      messages: [{ role: "user", content: detectionPrompt }]
    })
  });

  const data = await response.json();
  return (data.content?.[0]?.text || "NONE").trim();
}

// ─────────────────────────────────────────────────────────────────
// NORMALIZACIÓN DE PAÍSES
// ─────────────────────────────────────────────────────────────────
const COUNTRY_ALIASES = {
  "usa": "United States", "us": "United States", "united states": "United States",
  "united states of america": "United States", "estados unidos": "United States",
  "eua": "United States", "eeuu": "United States", "america": "United States",
  "norteamerica": "United States", "north america": "United States",
  "u.s.": "United States", "u.s.a.": "United States",
  "philippines": "Philippines", "filipinas": "Philippines", "pilipinas": "Philippines",
  "pinas": "Philippines", "ph": "Philippines", "phils": "Philippines",
  "mexico": "Mexico", "méxico": "Mexico", "mex": "Mexico",
  "spain": "Spain", "españa": "Spain", "espana": "Spain",
  "thailand": "Thailand", "tailandia": "Thailand", "thai": "Thailand",
  "indonesia": "Indonesia", "bali": "Indonesia",
  "japan": "Japan", "japon": "Japan", "japón": "Japan",
  "france": "France", "francia": "France",
  "italy": "Italy", "italia": "Italy",
  "portugal": "Portugal",
  "colombia": "Colombia",
  "peru": "Peru", "perú": "Peru",
  "argentina": "Argentina",
  "brazil": "Brazil", "brasil": "Brazil",
  "australia": "Australia",
  "uk": "United Kingdom", "united kingdom": "United Kingdom", "england": "United Kingdom",
  "britain": "United Kingdom", "reino unido": "United Kingdom", "inglaterra": "United Kingdom",
  "canada": "Canada", "canadá": "Canada",
};

function normalizeLocation(loc) {
  if (!loc) return loc;
  const lower = loc.toLowerCase().trim();
  return COUNTRY_ALIASES[lower] || loc;
}

function locationsMatch(a, b) {
  if (!a || !b) return false;
  const normA = normalizeLocation(a).toLowerCase();
  const normB = normalizeLocation(b).toLowerCase();
  return normA.includes(normB) || normB.includes(normA);
}

function buildSelectionMessage(propertiesList, filterLocation) {
  let filtered = propertiesList;

  if (filterLocation) {
    const normalizedFilter = normalizeLocation(filterLocation).toLowerCase();
    filtered = propertiesList.filter(p => {
      const propLocation = (p.location || "").toLowerCase();
      const propNormalized = normalizeLocation(p.location || "").toLowerCase();
      return propLocation.includes(normalizedFilter) ||
             propNormalized.includes(normalizedFilter) ||
             normalizedFilter.includes(propNormalized) ||
             locationsMatch(filterLocation, p.location);
    });
    if (filtered.length === 0) filtered = propertiesList;
  }

  // Agrupar por país
  const grouped = {};
  filtered.forEach(p => {
    const parts = (p.location || "").split(",");
    const country = parts.length > 1 ? parts[parts.length - 1].trim() : (p.location || "Other");
    if (!grouped[country]) grouped[country] = [];
    grouped[country].push(p);
  });

  let optionsText = "";
  let index = 1;
  const flatList = [];

  Object.entries(grouped).forEach(([country, props]) => {
    if (Object.keys(grouped).length > 1) {
      optionsText += `\n📍 *${country}*\n`;
    }
    props.forEach(p => {
      const city = (p.location || "").split(",")[0].trim();
      optionsText += `${index}. ${p.name}${city ? ` — ${city}` : ""}\n`;
      flatList.push(p);
      index++;
    });
  });

  return { optionsText: optionsText.trim(), flatList };
}

// ─────────────────────────────────────────────────────────────────
// LIMPIEZA DE MARKDOWN PARA WHATSAPP
// ─────────────────────────────────────────────────────────────────
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, '')
    .replace(/^- /gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatForWhatsApp(text) {
  text = text.replace(/\|(.+)\|/g, (match, content) => {
    if (/^[\s\-\|]+$/.test(match)) return '';
    const cells = content.split('|')
      .map(c => c.trim())
      .filter(c => c.length > 0 && !/^[-\s]+$/.test(c));
    if (cells.length === 0) return '';
    return cells.join(': ');
  });

  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/#{1,6}\s+(.+)/g, '*$1*')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2')
    .replace(/^---+$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────────────────────
// BOOKING FLOW — Extracción de datos estructurados
// ─────────────────────────────────────────────────────────────────

// Campos requeridos para crear un HOLD, en orden de preferencia
// LANI pide uno por uno siguiendo este orden
const BOOKING_FIELDS_ORDER = [
  "room_type",
  "check_in",
  "check_out",
  "guests_count",
  "guest_name",
  "guest_email",
  "guest_phone"
];

const FIELD_QUESTIONS_ES = {
  room_type: "¿Qué tipo de habitación te interesa?",
  check_in: "¿Cuál sería tu fecha de llegada (check-in)?",
  check_out: "¿Y la fecha de salida (check-out)?",
  guests_count: "¿Cuántas personas se hospedarían?",
  guest_name: "¿Me confirmas tu nombre completo, por favor?",
  guest_email: "¿Cuál es tu correo electrónico? Lo necesito para enviarte la confirmación.",
  guest_phone: "¿Me confirmas un número de teléfono donde podamos contactarte?"
};

const FIELD_QUESTIONS_EN = {
  room_type: "Which room type are you interested in?",
  check_in: "What would be your check-in date?",
  check_out: "And the check-out date?",
  guests_count: "How many guests will be staying?",
  guest_name: "Could you confirm your full name, please?",
  guest_email: "What's your email address? I'll need it to send you the confirmation.",
  guest_phone: "Could you share a phone number where we can reach you?"
};

function getTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function calculateNights(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const a = new Date(checkIn);
  const b = new Date(checkOut);
  if (isNaN(a) || isNaN(b)) return null;
  const diff = Math.round((b - a) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : null;
}

function calculateTotal(roomType, nights, roomRates) {
  if (!roomType || !nights || !roomRates) return null;
  const rate = roomRates[roomType.toLowerCase()] || roomRates[roomType];
  if (!rate) return null;
  return rate * nights;
}

function detectMissingFields(bookingData) {
  const missing = [];
  for (const field of BOOKING_FIELDS_ORDER) {
    const value = bookingData[field];
    if (value === undefined || value === null || value === "") {
      missing.push(field);
    }
  }
  return missing;
}

// ═══════════════════════════════════════════════════════════════════
// FIX BUG DE MEMORIA — extractBookingData v2
// Esta versión:
// 1. Lee TODO el historial conversacional (no solo últimos 6 mensajes)
// 2. Reconstruye el booking desde el historial (no depende solo de
//    activeBooking que viene de Make)
// 3. Le da al extractor instrucciones más fuertes para acumular datos
//    a través de turnos y manejar correcciones mid-flow
// ═══════════════════════════════════════════════════════════════════
async function extractBookingData({
  userMessage,
  previousMessages,
  activeBooking,
  roomRates,
  propertyName
}) {
  const todayISO = getTodayISO();
  const ratesText = roomRates && Object.keys(roomRates).length > 0
    ? Object.entries(roomRates).map(([k, v]) => `- ${k}: $${v}/night USD`).join("\n")
    : "(no room rates configured)";

  // ─────────────────────────────────────────────────────────────────
  // RECONSTRUIR EL BOOKING DESDE EL HISTORIAL
  // No confiamos solo en lo que mande Make. Leemos toda la
  // conversación para recuperar datos ya mencionados.
  // ─────────────────────────────────────────────────────────────────
  const reconstructedBooking = { ...(activeBooking || {}) };

  // Pasamos historial completo (no solo últimos 6) al prompt
  const fullHistoryText = previousMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const activeBookingText = Object.keys(reconstructedBooking).length > 0
    ? JSON.stringify(reconstructedBooking, null, 2)
    : "(no prior booking data passed in, but ALWAYS check conversation history below)";

  const prompt = `You are a data extraction engine for a hotel booking system.

PROPERTY: ${propertyName}
TODAY'S DATE: ${todayISO}

AVAILABLE ROOM TYPES AND RATES:
${ratesText}

CURRENT BOOKING DATA PASSED IN (may be empty — DO NOT rely on this alone):
${activeBookingText}

═══════════════════════════════════════════════════════════════
FULL CONVERSATION HISTORY (THIS IS YOUR SOURCE OF TRUTH):
${fullHistoryText || "(no prior messages)"}
═══════════════════════════════════════════════════════════════

LATEST GUEST MESSAGE:
"${userMessage}"

═══════════════════════════════════════════════════════════════
CRITICAL EXTRACTION RULES:
═══════════════════════════════════════════════════════════════

1. READ THE ENTIRE CONVERSATION HISTORY. Booking data may have been 
   given turns ago. NEVER discard information just because the 
   latest message doesn't repeat it.

2. ACCUMULATE data across turns:
   - If the guest said "garden room" 3 messages ago and now says 
     "yes, that's the one" → room_type STAYS as "garden_room"
   - If they gave dates earlier and now give their name → KEEP the 
     dates, add the name
   - Treat each turn as ADDING info, not REPLACING it

3. HANDLE CORRECTIONS gracefully:
   - "actually make it 4 people" → update guests_count to 4
   - "wait, change to ocean view" → update room_type to ocean_view
   - "no, 16th not 15th" → update check_in
   - Only update fields the guest EXPLICITLY corrected. Keep all others.

4. INTENT detection:
   - Phrases like "quiero reservar", "I want to book", "resérvame", 
     "book me" → intent: true
   - General questions about prices, amenities, availability → 
     intent: false
   - IF the conversation history shows a booking already in progress 
     (any booking field has a value) → intent: true, even if the 
     latest message is just confirming or providing one more piece 
     of data ("yes", "Daniel Arevalo", "daniel@test.com")

5. FIELDS TO EXTRACT:
   - room_type (string, must match one of: ${Object.keys(roomRates).join(", ") || "any"})
   - check_in (ISO date YYYY-MM-DD)
   - check_out (ISO date YYYY-MM-DD)
   - guests_count (integer)
   - guest_name (string, full name)
   - guest_email (string, valid email)
   - guest_phone (string, phone number)

6. DATE PARSING:
   - "del 15 al 18 de junio" with today being ${todayISO} → 
     check_in: nearest future June 15, check_out: nearest future June 18
   - "next weekend", "este fin de semana", "mañana", "tomorrow" → 
     calculate from ${todayISO}
   - If only one date given → fill check_in, leave check_out null

7. ROOM TYPE MATCHING (be flexible):
   - "garden", "la garden", "the garden one", "garden room por fa" → 
     room_type: "garden_room"
   - "ocean view", "vista al mar", "con vista" → "ocean_view"
   - "villa", "private villa", "la villa" → "villa"
   - If guest asks for a type NOT in available rates → set room_type 
     to null and note in extraction_notes

8. CONFIDENCE:
   - Only fill fields you are CONFIDENT about
   - If unclear ("como 4 o 5 personas"), pick the higher number and 
     note it in extraction_notes
   - NEVER invent emails, phones, or names

9. INPUT VALIDATION:
   - guest_email: must look like email (has @ and a dot)
   - guest_phone: must have digits (8+ characters typically)
   - guests_count: must be a positive integer 1-20
   - If a value doesn't pass validation → leave as null

═══════════════════════════════════════════════════════════════

RESPOND ONLY WITH A JSON OBJECT in this exact shape, no other text:
{
  "intent": true | false,
  "data": {
    "room_type": "..." | null,
    "check_in": "YYYY-MM-DD" | null,
    "check_out": "YYYY-MM-DD" | null,
    "guests_count": number | null,
    "guest_name": "..." | null,
    "guest_email": "..." | null,
    "guest_phone": "..." | null
  },
  "extraction_notes": "..." | null
}`;

  try {
    const response = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    let text = data.content?.[0]?.text || "{}";

    // Remove markdown fences if Claude added them
    text = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

    const extracted = JSON.parse(text);

    // ─────────────────────────────────────────────────────────────
    // MERGE: extracted values override empty/null in reconstructed
    // ─────────────────────────────────────────────────────────────
    const mergedData = { ...reconstructedBooking };
    for (const [key, value] of Object.entries(extracted.data || {})) {
      if (value !== null && value !== undefined && value !== "") {
        mergedData[key] = value;
      }
    }

    return {
      intent: extracted.intent === true,
      data: mergedData,
      extraction_notes: extracted.extraction_notes || null
    };

  } catch (err) {
    console.error("extractBookingData error:", err);
    return {
      intent: false,
      data: activeBooking || {},
      extraction_notes: "extraction_failed"
    };
  }
}

function detectLanguage(text) {
  // Simple heuristic: if message has strong Spanish markers, use ES
  const spanishMarkers = /\b(hola|gracias|por favor|quiero|cuanto|cuándo|reservar|habitación|noche|días)\b/i;
  return spanishMarkers.test(text) ? "es" : "en";
}

function buildBookingFlowResponse({
  bookingData,
  intent,
  roomRates,
  language
}) {
  // Compute nights and total if possible
  const nights = calculateNights(bookingData.check_in, bookingData.check_out);
  if (nights) bookingData.nights = nights;

  const total = calculateTotal(bookingData.room_type, nights, roomRates);
  if (total) bookingData.total_amount = total;

  const missing = detectMissingFields(bookingData);

  let stage;
  let nextQuestion = null;
  let suggestedReply = null;

  if (!intent) {
    stage = "NONE";
  } else if (missing.length === 0) {
    stage = "READY_TO_HOLD";
  } else {
    stage = "GATHERING_DATA";
    nextQuestion = missing[0];
    const questions = language === "es" ? FIELD_QUESTIONS_ES : FIELD_QUESTIONS_EN;
    suggestedReply = questions[nextQuestion];

    // Si lo siguiente es room_type y hay rates configurados, agregar opciones
    if (nextQuestion === "room_type" && roomRates && Object.keys(roomRates).length > 0) {
      const roomList = Object.entries(roomRates)
        .map(([k, v]) => `- ${k.charAt(0).toUpperCase() + k.slice(1)}: $${v} USD/noche`)
        .join("\n");
      suggestedReply = language === "es"
        ? `${suggestedReply}\n\nTenemos disponibles:\n${roomList}`
        : `${suggestedReply}\n\nWe have available:\n${roomList}`;
    }
  }

  return {
    intent,
    stage,
    data: bookingData,
    missing_fields: missing,
    next_question: nextQuestion,
    suggested_reply: suggestedReply,
    total_amount: bookingData.total_amount || null,
    nights: bookingData.nights || null
  };
}

// ─────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    let systemPrompt, userMessage, history, ownerWhatsapp, propertyId, propertiesListRaw;
    let activeBookingRaw, roomRatesRaw, propertyName;

    const contentType = event.headers["content-type"] || "";

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(event.body);
      systemPrompt      = params.get("systemPrompt") || "";
      userMessage       = params.get("userMessage");
      history           = params.get("history") || "[]";
      ownerWhatsapp     = params.get("ownerWhatsapp") || "";
      propertyId        = params.get("propertyId") || "";
      propertiesListRaw = params.get("propertiesList") || "[]";
      activeBookingRaw  = params.get("activeBooking") || "{}";
      roomRatesRaw      = params.get("roomRates") || "{}";
      propertyName      = params.get("propertyName") || "";
    } else {
      const body = JSON.parse(event.body);
      systemPrompt      = body.systemPrompt || "";
      userMessage       = body.userMessage;
      history           = body.history || "[]";
      ownerWhatsapp     = body.ownerWhatsapp || "";
      propertyId        = body.propertyId || "";
      propertiesListRaw = body.propertiesList || "[]";
      activeBookingRaw  = body.activeBooking || "{}";
      roomRatesRaw      = body.roomRates || "{}";
      propertyName      = body.propertyName || "";
    }

    if (!userMessage) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing userMessage" })
      };
    }

    // Parsear lista completa de propiedades
    let propertiesList = [];
    try { propertiesList = JSON.parse(propertiesListRaw); } catch (e) { propertiesList = []; }

    // Parsear activeBooking y roomRates
    let activeBooking = {};
    try { activeBooking = typeof activeBookingRaw === 'string' ? JSON.parse(activeBookingRaw) : activeBookingRaw; } catch (e) { activeBooking = {}; }
    if (!activeBooking || typeof activeBooking !== 'object') activeBooking = {};

    let roomRates = {};
    try { roomRates = typeof roomRatesRaw === 'string' ? JSON.parse(roomRatesRaw) : roomRatesRaw; } catch (e) { roomRates = {}; }
    if (!roomRates || typeof roomRates !== 'object') roomRates = {};

    // ─────────────────────────────────────────────────────────────
    // MODO IDENTIFICACIÓN — no hay propertyId aún
    // ─────────────────────────────────────────────────────────────
    if (!propertyId && propertiesList.length > 0) {

      let pendingFlatList = null;
      try {
        const parsedHistory = JSON.parse(history);
        const msgs = Array.isArray(parsedHistory) ? parsedHistory : (parsedHistory.messages || []);
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant" && msgs[i].__flatList) {
            pendingFlatList = msgs[i].__flatList;
            break;
          }
        }
      } catch (e) {}

      const listToDetect = pendingFlatList || propertiesList;
      const detected = await detectPropertyFromMessage(userMessage, listToDetect);

      if (detected !== "NONE" && detected !== "AMBIGUOUS" && !detected.startsWith("LOCATION_MULTIPLE")) {
        const confirmedProperty = listToDetect.find(p => p.property_id === detected);

        if (confirmedProperty) {
          const confirmMsg = `¡Hola! Soy LANI 👋, tu asistente virtual de *${confirmedProperty.name}*. ¿En qué puedo ayudarte hoy? 😊`;

          const updatedMessages = [
            { role: "user", content: userMessage },
            { role: "assistant", content: confirmMsg }
          ];

          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reply: confirmMsg,
              updatedHistory: JSON.stringify(updatedMessages),
              needsEscalation: false,
              escalationKeyword: null,
              detectedPropertyId: detected,
              bookingFlow: { intent: false, stage: "NONE", data: {}, missing_fields: [], next_question: null }
            })
          };
        }
      }

      if (detected.startsWith("LOCATION_MULTIPLE:")) {
        const location = detected.replace("LOCATION_MULTIPLE:", "").trim();
        const { optionsText, flatList } = buildSelectionMessage(propertiesList, location);

        const selectionMsg = `Tenemos estas propiedades en *${location}*:\n\n${optionsText}\n\nResponde con el número o nombre de la que te interesa. 😊`;

        const updatedMessages = [
          { role: "user", content: userMessage },
          { role: "assistant", content: selectionMsg, __flatList: flatList }
        ];

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reply: selectionMsg,
            updatedHistory: JSON.stringify(updatedMessages),
            needsEscalation: false,
            escalationKeyword: null,
            detectedPropertyId: null,
            bookingFlow: { intent: false, stage: "NONE", data: {}, missing_fields: [], next_question: null }
          })
        };
      }

      const { optionsText, flatList } = buildSelectionMessage(propertiesList, null);

      const selectionMsg = detected === "AMBIGUOUS"
        ? `Encontré más de una propiedad que podría coincidir. ¿Cuál te interesa?\n\n${optionsText}\n\nResponde con el número o nombre. 😊`
        : `¡Hola! Soy LANI 👋 ¿Con cuál de nuestras propiedades quieres contactar?\n\n${optionsText}\n\nResponde con el número o nombre.`;

      const updatedMessages = [
        { role: "user", content: userMessage },
        { role: "assistant", content: selectionMsg, __flatList: flatList }
      ];

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reply: selectionMsg,
          updatedHistory: JSON.stringify(updatedMessages),
          needsEscalation: false,
          escalationKeyword: null,
          detectedPropertyId: null,
          bookingFlow: { intent: false, stage: "NONE", data: {}, missing_fields: [], next_question: null }
        })
      };
    }

    // ─────────────────────────────────────────────────────────────
    // MODO NORMAL — propertyId existe, responder como LANI
    // ─────────────────────────────────────────────────────────────
    if (!systemPrompt) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing systemPrompt for known property" })
      };
    }

    // Parsear historial
    let previousMessages = [];
    let conversationSummary = "";

    try {
      const parsed = JSON.parse(history);

      if (parsed.summary) {
        conversationSummary = parsed.summary;
        previousMessages = parsed.messages || [];
      } else {
        previousMessages = Array.isArray(parsed) ? parsed : [];
      }

      // Limpiar __flatList del historial antes de mandarlo a Claude
      previousMessages = previousMessages.map(m => {
        const clean = { role: m.role, content: m.content };
        return clean;
      });

      if (previousMessages.length >= SUMMARY_THRESHOLD) {
        const summary = await summarizeHistory(previousMessages, systemPrompt);
        conversationSummary = summary;
        previousMessages = previousMessages.slice(-4);
      } else if (previousMessages.length > MAX_HISTORY) {
        previousMessages = previousMessages.slice(-MAX_HISTORY);
      }

    } catch (e) {
      previousMessages = [];
    }

    // ─────────────────────────────────────────────────────────────
    // BOOKING EXTRACTION (paralelo a la respuesta de LANI)
    // ─────────────────────────────────────────────────────────────
    const language = detectLanguage(userMessage);
    let bookingFlow = { intent: false, stage: "NONE", data: {}, missing_fields: [], next_question: null };

    try {
      const extraction = await extractBookingData({
        userMessage,
        previousMessages,
        activeBooking,
        roomRates,
        propertyName: propertyName || "this property"
      });

      bookingFlow = buildBookingFlowResponse({
        bookingData: extraction.data,
        intent: extraction.intent,
        roomRates,
        language
      });

      bookingFlow.extraction_notes = extraction.extraction_notes;
    } catch (err) {
      console.error("Booking extraction failed:", err);
    }

    // ─────────────────────────────────────────────────────────────
    // REGLA DE INTEGRIDAD DE DATOS
    // ─────────────────────────────────────────────────────────────
    const dataIntegrityRule = `

CRITICAL RULE — DATA INTEGRITY:
You must ONLY use information explicitly provided in this system prompt to answer guest questions.
If a guest asks about something not covered here (room types, prices, amenities, policies, availability, or any other detail), respond exactly like this:
"I don't have that information available right now. Please contact [owner name] directly for assistance."
NEVER invent, assume, or borrow details from other properties or your general knowledge.
If a field is empty or not mentioned in this prompt, treat it as unknown — do not fill in the gap.
This rule overrides everything else.`;

    // ─────────────────────────────────────────────────────────────
    // BOOKING CONTEXT INJECTION
    // ─────────────────────────────────────────────────────────────
    let bookingContext = "";

    if (bookingFlow.intent && bookingFlow.stage === "GATHERING_DATA") {
      const fieldsCollected = Object.entries(bookingFlow.data)
        .filter(([k, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");

      bookingContext = `

BOOKING FLOW ACTIVE — GATHERING DATA:
The guest is in the middle of making a booking. You have collected so far: ${fieldsCollected || "(nothing yet)"}.
You still need to ask for: ${bookingFlow.next_question}.

CRITICAL: Your reply must naturally ask for the next field (${bookingFlow.next_question}). 
Suggested phrasing: "${bookingFlow.suggested_reply}"
You may adapt the phrasing to sound natural in context, but MUST ask only for this one field.
Do NOT confirm the booking yet. Do NOT mention payment yet. Just gather the next piece of info conversationally.
Do NOT ask again for any field already listed in "collected so far".
Keep the warm, friendly tone of the property.`;
    } else if (bookingFlow.intent && bookingFlow.stage === "READY_TO_HOLD") {
      const total = bookingFlow.total_amount;
      const nights = bookingFlow.nights;
      bookingContext = `

BOOKING FLOW ACTIVE — READY TO HOLD:
The guest has provided all booking details. Total: $${total} USD for ${nights} nights.

CRITICAL: Your reply should:
1. Briefly summarize the booking (name, dates, room type, guests, total)
2. Say you are confirming the dates right now (the system will verify availability in seconds)
3. Do NOT say "you've secured the dates" yet — say "I'm confirming the dates"
4. Do NOT mention payment options yet — the system will handle that next
5. Keep it warm and natural, 3-4 lines max.

Example tone: "Perfecto Juan, déjame confirmar la disponibilidad para la Garden Room del 15 al 18 de junio (3 noches, $270 USD para 2 personas). Un segundo..."`;
    }

    const fullSystemPrompt = conversationSummary
      ? `${systemPrompt}${dataIntegrityRule}${bookingContext}\n\nConversation summary so far: ${conversationSummary}`
      : `${systemPrompt}${dataIntegrityRule}${bookingContext}`;

    const messages = [
      ...previousMessages,
      { role: "user", content: userMessage }
    ];

    const needsEscalation = detectEscalation(userMessage);

    let assistantReply;
    try {
      const response = await withTimeout(
        fetch(ANTHROPIC_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: fullSystemPrompt,
            messages: messages
          })
        }),
        TIMEOUT_MS
      );

      const data = await response.json();

      if (data.error) throw new Error(data.error.message);

      assistantReply = formatForWhatsApp(data.content[0].text);

    } catch (err) {
      if (err.message === "TIMEOUT") {
        assistantReply = ownerWhatsapp
          ? `Lo siento, tengo una conexión lenta en este momento. Por favor contáctanos directamente al ${ownerWhatsapp} para ayuda inmediata.`
          : "Lo siento, estoy experimentando una conexión lenta. Por favor intenta de nuevo en un momento.";
      } else {
        assistantReply = ownerWhatsapp
          ? `Estoy teniendo dificultades técnicas. Por favor contáctanos directamente al ${ownerWhatsapp}.`
          : "Estoy teniendo dificultades técnicas. Por favor intenta de nuevo en un momento.";
      }
    }

    // Asegurar que assistantReply es solo un string de texto, nunca JSON
    let cleanReply = typeof assistantReply === 'string' ? assistantReply.trim() : String(assistantReply).trim();
    if (cleanReply.startsWith('[') || cleanReply.startsWith('{')) {
      cleanReply = "Disculpa, hubo un error. Por favor intenta de nuevo.";
    }

    const updatedMessages = [
      ...previousMessages,
      { role: "user", content: userMessage },
      { role: "assistant", content: cleanReply }
    ];

    const updatedHistory = JSON.stringify(
      conversationSummary
        ? { summary: conversationSummary, messages: updatedMessages }
        : updatedMessages
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: stripMarkdown(cleanReply),
        updatedHistory: updatedHistory,
        needsEscalation: needsEscalation,
        escalationKeyword: needsEscalation
          ? ESCALATION_KEYWORDS.find(k => userMessage.toLowerCase().includes(k))
          : null,
        detectedPropertyId: null,
        bookingFlow: bookingFlow
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    };
  }
};
