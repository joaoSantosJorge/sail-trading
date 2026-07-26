// Bootstrap: load .env.local BEFORE any @/server import parses env.ts.
// (Static imports hoist, so the worker body lives in main.ts and is imported
// dynamically. On Railway, env comes from the platform and dotenv no-ops.)
import { config } from "dotenv";
config({ path: ".env.local" });

void import("./main");
