"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApplication } = require("./server");

const parties = [{
  "party code": "P-1",
  "party name": "Example Party",
  "party add1": "Address 1",
  "party add 2": "Address 2",
  city: "City",
  state: "State",
  pin: "123456",
  "state 1": "State",
  status: "Active",
  "md/td": "MD"
}];
const products = [{
  "part number": "PART-1",
  "product code": "CODE-1",
  "product name": "Example Product",
  mrp: 100,
  "md price": 80,
  "td price": 85
}];

async function createTestServer(t, productRows = products) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "form-markexhaust-"));
  const submissionsPath = path.join(directory, "submissions.json");
  const server = http.createServer(createApplication({
    parties,
    products: productRows,
    submissionsPath,
    password: "test-password-123"
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, submissionsPath };
}

test("product search returns the selected party's price type", async t => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/products?partyCode=P-1&q=example`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    "part number": "PART-1",
    "product code": "CODE-1",
    "product name": "Example Product",
    mrp: 100,
    price: 80,
    "price type": "MD"
  }]);
});

test("product dropdown is capped while searches can still find later products", async t => {
  const manyProducts = Array.from({ length: 45 }, (_, index) => ({
    "part number": `PART-${index + 1}`,
    "product code": `CODE-${index + 1}`,
    "product name": index === 44 ? "Distinctive Searchable Product" : `Product ${index + 1}`,
    mrp: 100,
    "md price": 80,
    "td price": 85
  }));
  const { baseUrl } = await createTestServer(t, manyProducts);

  const browseResponse = await fetch(`${baseUrl}/api/products?partyCode=P-1&q=`);
  assert.equal((await browseResponse.json()).length, 40);

  const searchResponse = await fetch(`${baseUrl}/api/products?partyCode=P-1&q=Distinctive`);
  const matches = await searchResponse.json();
  assert.equal(matches.length, 1);
  assert.equal(matches[0]["product name"], "Distinctive Searchable Product");
});

test("submissions reject invalid quantities and persist server-validated product values", async t => {
  const { baseUrl, submissionsPath } = await createTestServer(t);
  const invalidResponse = await fetch(`${baseUrl}/api/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "party code": "P-1",
      products: [{ "part number": "PART-1", quantity: 0 }]
    })
  });
  assert.equal(invalidResponse.status, 400);
  await assert.rejects(fs.access(submissionsPath));

  const validResponse = await fetch(`${baseUrl}/api/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "party code": "P-1",
      products: [{ "part number": "PART-1", quantity: 2 }]
    })
  });
  assert.equal(validResponse.status, 201);
  const saved = JSON.parse(await fs.readFile(submissionsPath, "utf8")).submissions[0];
  assert.equal(saved["party name"], "Example Party");
  assert.equal(saved.products[0].price, 80);
  assert.equal(saved.products[0].quantity, 2);
  assert.ok(Number.isFinite(Date.parse(saved["submitted at"])));
});

test("admin submissions require a session", async t => {
  const { baseUrl } = await createTestServer(t);
  const denied = await fetch(`${baseUrl}/api/admin/submissions`);
  assert.equal(denied.status, 401);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password-123" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const authorized = await fetch(`${baseUrl}/api/admin/submissions`, {
    headers: { Cookie: cookie }
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), []);
});
