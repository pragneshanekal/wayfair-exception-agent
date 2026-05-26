#!/usr/bin/env node
// POST all 8 exception cases to the local dev server.
// Usage: node eval/run.js [base_url]
// Default base URL: http://localhost:8787

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const BASE_URL = process.argv[2] ?? "http://localhost:8787";
const cases = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "cases.json"), "utf8"),
);

console.log(`Submitting ${cases.length} cases to ${BASE_URL}\n`);

for (const c of cases) {
  const payload = { id: c.id, ...c.input, severity: c.severity };
  try {
    const res = await fetch(`${BASE_URL}/case`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    console.log(`✓ ${c.id} (${c.input.exception_type}) → ${data.status ?? data.caseId}`);
  } catch (err) {
    console.error(`✗ ${c.id} — ${err.message}`);
  }
}

console.log(`\nDone. Check ${BASE_URL} to view results.`);
