"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const PARTY_FIELDS = [
  "party code",
  "party name",
  "party add1",
  "party add 2",
  "city",
  "state",
  "pin",
  "state 1",
  "status",
  "md/td"
];
const PRODUCT_FIELDS = ["part number", "product code", "product name", "mrp", "md price", "td price"];
const MAX_REQUEST_BYTES = 65536;
const MAX_PRODUCT_RESULTS = 40;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function normalizeRows(rows, fields, filename, stringifyValues) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${filename} must contain a non-empty JSON array.`);
  }

  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${filename} row ${index + 1} must be an object.`);
    }

    const record = {};
    for (const field of fields) {
      if (!hasOwn(row, field)) {
        throw new Error(`${filename} row ${index + 1} is missing the required "${field}" field.`);
      }
      const value = row[field];
      record[field] = stringifyValues ? (value == null ? "" : String(value)) : value;
    }
    return record;
  });
}

async function loadMasterData(directory = __dirname) {
  const partiesPath = path.join(directory, "parties.json");
  const productsPath = path.join(directory, "products.json");
  let partyRows;
  let productRows;

  try {
    partyRows = JSON.parse(await fs.readFile(partiesPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Party data file not found: parties.json");
    if (error instanceof SyntaxError) throw new Error("Party data file is not valid JSON.");
    throw error;
  }

  try {
    productRows = JSON.parse(await fs.readFile(productsPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Product data file not found: products.json");
    if (error instanceof SyntaxError) throw new Error("Product data file is not valid JSON.");
    throw error;
  }

  const parties = normalizeRows(partyRows, PARTY_FIELDS, "Party data", true);
  const partyCodes = new Set();
  for (const party of parties) {
    const code = party["party code"].toLowerCase();
    if (partyCodes.has(code)) throw new Error("Party data contains duplicate party codes.");
    partyCodes.add(code);
  }

  const products = normalizeRows(productRows, PRODUCT_FIELDS, "Product data", false);
  const partNumbers = new Set();
  for (const product of products) {
    const partNumber = String(product["part number"] ?? "");
    const key = partNumber.toLowerCase();
    if (!partNumber.trim() || partNumbers.has(key)) {
      throw new Error("Product data contains an empty or duplicate part number.");
    }
    partNumbers.add(key);
  }

  return { parties, products };
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Request is too large.");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }

  if (size === 0) throw new HttpError(400, "Request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}

function sendJson(response, statusCode, value, headers = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function readCookie(request, name) {
  const cookies = (request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return null;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createApplication({ parties, products, submissionsPath, password, username = "admin", webRoot = __dirname }) {
  if (!Array.isArray(parties) || !Array.isArray(products)) {
    throw new Error("Party and product records are required.");
  }
  if (typeof password !== "string" || !password.trim() || password.length < 12) {
    throw new Error("Use an admin password with at least 12 characters.");
  }
  if (typeof submissionsPath !== "string" || !submissionsPath) {
    throw new Error("A submissions file path is required.");
  }

  const partyByCode = new Map(parties.map(party => [party["party code"], party]));
  const productByPart = new Map(
    products.map(product => [String(product["part number"]).toLowerCase(), product])
  );
  const sessions = new Map();
  let writeQueue = Promise.resolve();

  async function readSubmissions() {
    let content;
    try {
      content = await fs.readFile(submissionsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }

    let document;
    try {
      document = JSON.parse(content);
    } catch {
      throw new Error("Submissions file is not valid JSON.");
    }
    if (Array.isArray(document)) return document;
    if (document && Array.isArray(document.submissions)) return document.submissions;
    throw new Error("Submissions file has an invalid format.");
  }

  async function saveSubmissions(items) {
    const temporaryPath = `${submissionsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify({ submissions: items }, null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
      await fs.rename(temporaryPath, submissionsPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  function appendSubmission(submission) {
    const operation = writeQueue.then(async () => {
      const items = await readSubmissions();
      items.push(submission);
      await saveSubmissions(items);
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function clearSessionCookie(request, response) {
    response.setHeader(
      "Set-Cookie",
      `admin_session=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${isSecureRequest(request) ? "; Secure" : ""}`
    );
  }

  function isSecureRequest(request) {
    const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    return process.env.NODE_ENV === "production" || forwardedProto === "https";
  }

  function getValidSession(request) {
    const token = readCookie(request, "admin_session");
    if (!token) return null;
    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return token;
  }

  async function serveFile(response, filename) {
    const body = await fs.readFile(path.join(webRoot, filename));
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(body);
  }

  return async function handleRequest(request, response) {
    try {
      const requestUrl = new URL(request.url || "/", "http://localhost");
      const route = requestUrl.pathname;
      const method = request.method || "GET";

      for (const [token, expiresAt] of sessions) {
        if (expiresAt <= Date.now()) sessions.delete(token);
      }

      if (method === "GET" && (route === "/" || route === "/admin")) {
        await serveFile(response, route === "/" ? "index.html" : "admin.html");
        return;
      }

      if (method === "GET" && route === "/api/parties") {
        sendJson(response, 200, parties);
        return;
      }

      if (method === "GET" && route === "/api/products") {
        const partyCode = requestUrl.searchParams.get("partyCode") || "";
        const query = (requestUrl.searchParams.get("q") || "").trim();
        const party = partyByCode.get(partyCode);
        if (!party) {
          sendJson(response, 400, { error: "Select a valid party before searching products." });
          return;
        }

        const priceType = String(party["md/td"] || "").trim().toUpperCase();
        if (priceType !== "MD" && priceType !== "TD") {
          sendJson(response, 400, { error: "This party has no valid MD/TD price type." });
          return;
        }

        const priceField = priceType === "MD" ? "md price" : "td price";
        const normalizedQuery = query.toLowerCase();
        const matches = [];
        for (const product of products) {
          const fields = ["part number", "product code", "product name"];
          if (normalizedQuery && !fields.some(field =>
            String(product[field] ?? "").toLowerCase().includes(normalizedQuery)
          )) {
            continue;
          }

          matches.push({
            "part number": product["part number"],
            "product code": product["product code"],
            "product name": product["product name"],
            mrp: product.mrp,
            price: product[priceField],
            "price type": priceType
          });
          if (matches.length >= MAX_PRODUCT_RESULTS) break;
        }
        sendJson(response, 200, matches);
        return;
      }

      if (method === "POST" && route === "/api/submissions") {
        const payload = await readJsonBody(request);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new HttpError(400, "Invalid request.");
        }

        const partyCode = String(payload["party code"] ?? "");
        const party = partyByCode.get(partyCode);
        if (!party) {
          sendJson(response, 400, { error: "Select a valid party before submitting." });
          return;
        }

        const requestedProducts = payload.products;
        if (!Array.isArray(requestedProducts) || requestedProducts.length < 1 || requestedProducts.length > 50) {
          sendJson(response, 400, { error: "Add between 1 and 50 products before submitting." });
          return;
        }

        const priceType = String(party["md/td"] || "").trim().toUpperCase();
        if (priceType !== "MD" && priceType !== "TD") {
          sendJson(response, 400, { error: "This party has no valid MD/TD price type." });
          return;
        }

        const priceField = priceType === "MD" ? "md price" : "td price";
        const submittedProducts = [];
        for (const requestedProduct of requestedProducts) {
          const partNumber = String(requestedProduct?.["part number"] ?? "");
          const product = productByPart.get(partNumber.toLowerCase());
          if (!product) {
            sendJson(response, 400, { error: "A submitted product is not in the product list." });
            return;
          }

          const quantity = Number(requestedProduct.quantity);
          if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000000) {
            sendJson(response, 400, {
              error: "Product quantity must be greater than 0 and no more than 10,000,000."
            });
            return;
          }

          submittedProducts.push({
            "part number": product["part number"],
            "product code": product["product code"],
            "product name": product["product name"],
            mrp: product.mrp,
            "price type": priceType,
            price: product[priceField],
            quantity
          });
        }

        const submission = Object.fromEntries(PARTY_FIELDS.map(field => [field, party[field]]));
        submission.products = submittedProducts;
        submission["submitted at"] = new Date().toISOString();

        await appendSubmission(submission);
        sendJson(response, 201, { message: "Submission received." });
        return;
      }

      if (method === "POST" && route === "/api/admin/login") {
        const payload = await readJsonBody(request);
        const providedUsername = String(payload?.username ?? "");
        const providedPassword = String(payload?.password ?? "");
        if (providedUsername !== username || !safeEqual(providedPassword, password)) {
          sendJson(response, 401, { error: "Incorrect username or password." });
          return;
        }

        const token = crypto.randomBytes(32).toString("base64url");
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        const secureAttribute = isSecureRequest(request) ? "; Secure" : "";
        sendJson(response, 200, { message: "Signed in." }, {
          "Set-Cookie": `admin_session=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=28800${secureAttribute}`
        });
        return;
      }

      if (method === "GET" && route === "/api/admin/session") {
        sendJson(response, 200, { authenticated: Boolean(getValidSession(request)) });
        return;
      }

      if (route.startsWith("/api/admin/")) {
        const token = getValidSession(request);
        if (!token) {
          clearSessionCookie(request, response);
          sendJson(response, 401, { error: "Admin sign-in required." });
          return;
        }

        if (method === "GET" && route === "/api/admin/submissions") {
          sendJson(response, 200, await readSubmissions());
          return;
        }

        if (method === "POST" && route === "/api/admin/logout") {
          sessions.delete(token);
          clearSessionCookie(request, response);
          sendJson(response, 200, { message: "Signed out." });
          return;
        }
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }
      console.error("Request failed:", error);
      sendJson(response, 500, { error: "Server error." });
    }
  };
}

async function promptForPassword() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Set PARTY_ADMIN_PASSWORD in the environment before starting the server.");
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let password = "";
    let finished = false;
    process.stdout.write("Set the admin password for this run (minimum 12 characters): ");
    input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
    };

    const onData = chunk => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Password prompt cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(password);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          const characters = Array.from(password);
          if (characters.length > 0) {
            characters.pop();
            password = characters.join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        password += character;
        process.stdout.write("*");
      }
    };

    input.on("data", onData);
  });
}

async function start() {
  let password = process.env.PARTY_ADMIN_PASSWORD;
  delete process.env.PARTY_ADMIN_PASSWORD;
  if (typeof password !== "string" || !password.trim()) password = await promptForPassword();
  if (!password.trim() || password.length < 12) {
    throw new Error("Use an admin password with at least 12 characters.");
  }

  const { parties, products } = await loadMasterData();
  const handler = createApplication({
    parties,
    products,
    submissionsPath: path.join(__dirname, "submissions.json"),
    password
  });
  password = "";

  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  const server = http.createServer(handler);
  server.listen(port, host, () => {
    console.log(`Party form running at http://${host}:${port}/`);
    console.log(`Admin panel: http://${host}:${port}/admin`);
    console.log("Press Ctrl+C to stop the server. Submissions are saved in submissions.json.");
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApplication, loadMasterData };
