import { migrateWithRetry, closePool } from "../db";

const applied = await migrateWithRetry();
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
await closePool();
