#!/usr/bin/env node
// Scrape FDA Ghana Products Register — filtered to DRUG/DRUGS.
// Writes a JSON file ready for import_fda_catalog.
// Usage: node scripts/scrape-fda.js [--out /tmp/fda-drugs.json]

const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "/tmp/fda-drugs.json";

const BASE = "https://verifypermit.fdaghana.gov.gh/publicsearch";
const PAGE_SIZE = 200;
const DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(start, length, draw) {
  const params = new URLSearchParams({
    draw: String(draw),
    "columns[0][data]": "DT_RowIndex",
    "columns[1][data]": "client_name",
    "columns[2][data]": "product_name",
    "columns[3][data]": "product_category",
    "columns[4][data]": "expiry_date",
    "columns[5][data]": "status",
    "columns[6][data]": "action",
    "order[0][column]": "1",
    "order[0][dir]": "desc",
    start: String(start),
    length: String(length),
    "search[value]": "",
    "search[regex]": "false",
  });
  const url = `${BASE}?${params}`;
  const res = await fetch(url, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
      "User-Agent": "Pulse-FDA-Scraper/1.0",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for start=${start}`);
  return res.json();
}

async function main() {
  console.log("Fetching FDA register (this takes ~1-2 minutes, 77 pages)...");
  let start = 0;
  let draw = 1;
  let total = null;
  const all = [];
  while (true) {
    const json = await fetchPage(start, PAGE_SIZE, draw++);
    if (total === null) {
      total = json.recordsTotal;
      console.log(`Total records: ${total}`);
    }
    const rows = json.data || [];
    if (rows.length === 0) break;
    // Filter to drugs only (chemical sellers).
    const drugs = rows.filter((r) => {
      const c = (r.product_category || "").toUpperCase();
      return c === "DRUG" || c === "DRUGS";
    });
    for (const r of drugs) {
      all.push({
        id: r.product_uuid || r.product_id || String(r.id),
        product_id: r.product_id || null,
        product_name: r.product_name || "",
        generic_name: r.generic_name || null,
        strength: r.strength || null,
        active_ingredient: r.active_ingredient || null,
        dosage_form: r.dosage_form_indication || r.dosage_form || null,
        product_category: r.product_category || null,
        product_sub_category: r.product_sub_category || null,
        registration_number: r.registration_number || null,
        manufacturer: r.manufacturer || null,
        client_name: r.client_name || null,
        registration_date: r.registration_date || null,
        expiry_date: r.expiry_date || null,
        status: r.status || null,
      });
    }
    console.log(`  page start=${start} rows=${rows.length} drugs=${drugs.length} total drugs so far=${all.length}`);
    start += rows.length;
    if (rows.length < PAGE_SIZE) break;
    if (json.recordsFiltered && start >= json.recordsFiltered) break;
    await sleep(DELAY_MS);
  }
  const fs = await import("fs");
  fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
  console.log(`\nDone. Wrote ${all.length} DRUG/DRUGS to ${OUT}`);
  console.log(`To load into Pulse: Settings → Update FDA catalog (or call import_fda_catalog)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
