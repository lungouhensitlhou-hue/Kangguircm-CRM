import { migrate, closePool } from "../db";

const applied = await migrate();
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
await closePool();
