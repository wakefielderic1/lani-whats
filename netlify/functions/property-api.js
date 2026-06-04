const { google } = require("googleapis");

const SHEET_ID = "16m3aJAs23FaEbveyTKRfiXLHOBkByR2JU9CZjhChncQ";
const PROPERTY_ID = "casa-frida";

async function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth.getClient();
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

async function getPropertyRow(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Properties!A:A",
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === PROPERTY_ID) return i + 1;
  }
  return null;
}

async function getPropertyData(sheets, rowNum) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `Properties!A${rowNum}:AQ${rowNum}`,
  });
  const row = res.data.values?.[0] || [];

  // Map columns by header position (0-indexed)
  // A=0 property_id, B=1 property_name, E=4 address, I=8 checkin, J=9 checkout
  // P=15 deposit, Q=16 currency, U=20 upsells, X=23 owner_name, Y=24 owner_whatsapp
  // Z=25 owner_email, AA=26 property_whatsapp, AD=29 tone, AF=31 ai_notes
  // AK=36 price_room (price_garden_room)
  let upsells = [];
  try { upsells = JSON.parse(row[20] || "[]"); } catch { upsells = []; }

  return {
    property_name: row[1] || "Casa Frida 516",
    address: row[4] || "",
    checkin: row[8] || "15:00",
    checkout: row[9] || "11:00",
    currency: row[16] || "MXN",
    owner_name: row[23] || "",
    price_room: row[36] || "800",
    upsells,
    tone: row[29] || "",
  };
}

async function getBookings(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Bookings!A:T",
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  // Header row: A=booking_code, B=property_id, C=guest_name, D=guest_phone,
  // E=guest_email, F=check_in, G=check_out, H=nights, I=room_type,
  // J=guests_count, K=total_amount, L=status, M=payment_method,
  // N=payment_link, O=calendar_event_id, P=created_at, Q=confirmed_at,
  // R=stripe_session_id, S=hold_expires_at, T=add_ons_json

  const bookings = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[1] || row[1] !== PROPERTY_ID) continue;
    bookings.push({
      booking_code: row[0] || "",
      guest_name: row[2] || "",
      guest_phone: row[3] || "",
      guest_email: row[4] || "",
      check_in: row[5] || "",
      check_out: row[6] || "",
      nights: row[7] || "",
      room_type: row[8] || "",
      guests_count: row[9] || "",
      total_amount: row[10] || "",
      status: row[11] || "",
      payment_method: row[12] || "",
      created_at: row[15] || "",
      confirmed_at: row[16] || "",
      hold_expires_at: row[18] || "",
      add_ons: (() => { try { return JSON.parse(row[19] || "[]"); } catch { return []; } })(),
    });
  }
  return bookings;
}

async function getConversations(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "conversations!A:E",
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  // Header: A=phone, B=property_whatsapp, C=history, D=last_updated, E=property_id
  const convs = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[4] || row[4] !== PROPERTY_ID) continue;
    let history = { summary: "", messages: [] };
    try { history = JSON.parse(row[2] || "{}"); } catch {}
    convs.push({
      phone: row[0] || "",
      last_updated: row[3] || "",
      summary: history.summary || "",
      messages: (history.messages || []).slice(-10), // last 10 messages only
    });
  }
  return convs;
}

async function updateProperty(sheets, rowNum, updates) {
  // Column map for updatable fields
  const fieldToCol = {
    price_room: 37,   // AK
    checkin: 9,       // I
    checkout: 10,     // J
    upsells: 21,      // U
  };

  const data = [];
  for (const [field, col] of Object.entries(fieldToCol)) {
    if (updates[field] !== undefined) {
      const value = field === "upsells"
        ? JSON.stringify(updates[field])
        : String(updates[field]);
      data.push({
        range: `Properties!${colLetter(col)}${rowNum}`,
        values: [[value]],
      });
    }
  }

  if (data.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const rowNum = await getPropertyRow(sheets);

    if (!rowNum) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "casa-frida no encontrada" }) };
    }

    if (event.httpMethod === "GET") {
      const [property, bookings, conversations] = await Promise.all([
        getPropertyData(sheets, rowNum),
        getBookings(sheets),
        getConversations(sheets),
      ]);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ property, bookings, conversations }),
      };
    }

    if (event.httpMethod === "POST") {
      const updates = JSON.parse(event.body || "{}");
      await updateProperty(sheets, rowNum, updates);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, updated: Object.keys(updates) }),
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch (err) {
    console.error("property-api error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
