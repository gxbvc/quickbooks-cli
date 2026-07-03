import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CliError } from "./output.js";

const __filename = fileURLToPath(import.meta.url);
// dist/config.js (or src/config.ts under tsx) -> tool root
export const TOOL_DIR = join(dirname(__filename), "..");
export const ENV_FILE = join(TOOL_DIR, ".env");
export const TOKENS_FILE = join(TOOL_DIR, "tokens.json");

loadDotenv({ path: ENV_FILE });

export const MINOR_VERSION = "75";
export const REDIRECT_URI = process.env.QB_REDIRECT_URI || "http://localhost:3456/callback";
export const OAUTH_CALLBACK_PORT = 3456;
export const DEFAULT_PROD_BANKFEED_REALM = "9341456741690479"; // Abelian Labs, LLC

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new CliError(
      `${name} is not set. Copy .env.example to .env in ${TOOL_DIR} and fill in your Intuit app credentials (developer.intuit.com).`,
      "MISSING_ENV"
    );
  }
  return val;
}

export function getClientId(): string {
  return requireEnv("QB_CLIENT_ID");
}

export function getClientSecret(): string {
  return requireEnv("QB_CLIENT_SECRET");
}

export function getEnvironment(): "sandbox" | "production" {
  const raw = (process.env.QB_ENVIRONMENT || "sandbox").toLowerCase();
  if (raw !== "sandbox" && raw !== "production") {
    throw new CliError(
      `QB_ENVIRONMENT must be "sandbox" or "production" (got "${process.env.QB_ENVIRONMENT}").`,
      "INVALID_ENV"
    );
  }
  return raw;
}

export function getApiBase(): string {
  return getEnvironment() === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

/** Realm (company) ID: QB_REALM_ID env, falling back to the one captured in tokens.json. */
export function getRealmId(): string {
  if (process.env.QB_REALM_ID) return process.env.QB_REALM_ID;
  try {
    const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf-8"));
    if (tokens?.realm_id) return String(tokens.realm_id);
  } catch {
    // no tokens.json yet — fall through to the error
  }
  throw new CliError(
    "QB_REALM_ID is not set (and no realm captured in tokens.json). Set it in .env or run `quickbooks-cli auth`, which captures the realm from the OAuth callback.",
    "MISSING_REALM"
  );
}
