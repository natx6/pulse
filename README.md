# Pulse Pharmacy — lightweight desktop POS (Tauri v2 + React + SQLite)

Fast-first pharmacy management system: scan barcode -> item in cart -> beep -> sell.
Built for Ghana pharmacies: GHS pricing, MoMo/Cash/Card, offline-first, tiny footprint.

## Stack

- Tauri v2 (Rust shell, reuses OS webview — no bundled Chromium)
- React 18 + Vite + Tailwind CSS v4
- SQLite via tauri-plugin-sql (WAL mode), atomic sales in Rust (rusqlite transaction)
- Zustand for UI state (cart, page, products cache)
- Barcode: native keyboard-event listener (USB HID scanners), WebAudio beeps, no assets

## Run it

Prerequisites (Fedora):

    sudo dnf install webkit2gtk4.1-devel openssl-devel librsvg2-devel libxdo-devel patchelf rust cargo

Then:

    npm install
    npm run tauri dev

First run compiles the Rust shell (2-5 min); after that it starts in seconds.
`npm run dev` alone runs the frontend in a browser (no SQLite/Rust — POS buttons
will error until run through Tauri).

## The sale path

complete_sale (src-tauri/src/lib.rs) runs one BEGIN IMMEDIATE transaction:
stock check -> receipt number (per-day sequence) -> insert sale -> insert items
-> deduct stock -> COMMIT. If the power dies mid-sale, nothing is written.

## Data

SQLite lives in the OS config dir (`~/.config/com.pulse.pharmacy/pulse.db` on
Linux) — tauri-plugin-sql resolves relative sqlite paths there, and the Rust
commands must (and do) use the same path. Backups and CSV exports land in
`backups/` and `exports/` next to the database file.
Demo seed products ship with the first migration — delete the rows to start clean:

    DELETE FROM products;

## Keyboard map

- F9 / F10 / F11 — Cash / Card / MoMo: on the POS screen these open
  checkout pre-selected (with an item in the cart); inside the payment
  screen they switch the method
- F2 — open Inventory Intake from anywhere
- Ctrl+K — focus the global search
- Esc — close modals
- Enter — confirm in modals / add barcode in the POS search

## Roadmap (intentionally not built)

- NHIS claims, credit sales ledger, controlled-drug register, shifts
- ESC/POS direct thermal printing (currently browser print)
- Offline font bundling (Inter/Material Symbols currently load from Google Fonts)

## Project layout

    src/                 React app
      pages/             POS, Inventory, Restocking, Dispensing, Analytics, Settings
      components/        Sidebar, TopBar, modals (payment, receipt, intake, quick-add)
      lib/               scanner, audio (WebAudio beeps), stock status, money
      db.ts              SQLite init + queries (plugin)
      store/useStore.ts  Zustand
    src-tauri/
      src/lib.rs         atomic complete_sale + backup_db commands
      migrations/        SQLite schema + demo seed
