const { google } = require("googleapis");

const SHEET_ID = "16m3aJAs23FaEbveyTKRfiXLHOBkByR2JU9CZjhChncQ";
const PROPERTY_ID = "casa-frida";

// Column mapping (1-indexed) — ajustar si cambian columnas en el Sheet
const COLS = {
  property_id: 1,
  property_name: 2,
  address: 3,
  checkin: 4,
  checkout: 5,
  price_room: 6,
  price_villa: 7,
  currency: 8,
  max_guests: 9,
  rooms: 10,
  upsells: 21,   // columna U
  owner_name: 24, // columna X
  owner_whatsapp: 25, // columna Y
  property_whatsapp: 26, // columna Z
  tone: 30,       // columna AD
};

async function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth.getClient();
}

async function findPropertyRow(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Properties!A:A",
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === PROPERTY_ID) return i + 1; // 1-indexed
  }
  return null;
}

async function getPropertyData(sheets, rowNum) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `Properties!A${rowNum}:AJ${rowNum}`,
  });
  const row = res.data.values?.[0] || [];

  let upsells = [];
  try {
    upsells = JSON.parse(row[COLS.upsells - 1] || "[]");
  } catch {
    upsells = [];
  }

  return {
    property_name: row[COLS.property_name - 1] || "",
    address: row[COLS.address - 1] || "",
    checkin: row[COLS.checkin - 1] || "",
    checkout: row[COLS.checkout - 1] || "",
    price_room: row[COLS.price_room - 1] || "",
    currency: row[COLS.currency - 1] || "MXN",
    max_guests: row[COLS.max_guests - 1] || "",
    rooms: row[COLS.rooms - 1] || "",
    upsells,
    owner_name: row[COLS.owner_name - 1] || "",
    tone: row[COLS.tone - 1] || "",
  };
}

async function updatePropertyRow(sheets, rowNum, updates) {
  const requests = [];

  const fieldToCol = {
    price_room: COLS.price_room,
    checkin: COLS.checkin,
    checkout: COLS.checkout,
    upsells: COLS.upsells,
    tone: COLS.tone,
  };

  for (const [field, col] of Object.entries(fieldToCol)) {
    if (updates[field] !== undefined) {
      const value = field === "upsells"
        ? JSON.stringify(updates[field])
        : String(updates[field]);

      requests.push({
        range: `Properties!${colLetter(col)}${rowNum}`,
        values: [[value]],
      });
    }
  }

  if (requests.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: requests,
    },
  });
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const rowNum = await findPropertyRow(sheets);

    if (!rowNum) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Propiedad casa-frida no encontrada" }),
      };
    }

    if (event.httpMethod === "GET") {
      const data = await getPropertyData(sheets, rowNum);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (event.httpMethod === "POST") {
      const updates = JSON.parse(event.body || "{}");
      await updatePropertyRow(sheets, rowNum, updates);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, updated: Object.keys(updates) }),
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Método no permitido" }) };

  } catch (err) {
    console.error("property-api error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
