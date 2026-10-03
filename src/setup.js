#!/usr/bin/env node
/**
 * WI-MCP Setup — first-run configuration and consent management.
 *
 * Usage:
 *   node src/setup.js                # Interactive setup
 *   node src/setup.js --consent      # Grant consent (non-interactive)
 *   node src/setup.js --revoke       # Revoke consent
 *   node src/setup.js --status       # Show current config
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline";

const CONFIG_DIR = join(homedir(), ".wi-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CONSENT_VERSION = "1.0";

const CONSENT_TEXT = `Dein Webinar wird besser, je mehr wir lernen.

Wir speichern anonym, welche Fakten und Texte zu erfolgreichen Webinaren
fuehren — nie deine WordPress-Zugangsdaten oder Teilnehmerdaten. Du bekommst
dadurch schneller ein besser konvertierendes Webinar.

Keine Weitergabe an Dritte. Widerruf jederzeit per E-Mail an
support@webinarignition.com.`;

function loadConfig() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(CONFIG_PATH)) {
    const cfg = {
      client_id: crypto.randomUUID(),
      consent_granted: false,
      consent_version: "",
      consent_granted_at: 0,
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function ask(query) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (a) => { rl.close(); resolve(a); }));
}

async function grantConsent(config) {
  console.log("\n" + CONSENT_TEXT + "\n");
  const answer = await ask("Do you consent to anonymized learning? (yes/no): ");
  if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
    console.log("Consent not granted. You can run 'node src/setup.js --consent' anytime.");
    return false;
  }
  config.consent_granted = true;
  config.consent_version = CONSENT_VERSION;
  config.consent_granted_at = Math.floor(Date.now() / 1000);
  saveConfig(config);
  console.log("Consent granted. Thank you! Your webinars will improve over time.");
  return true;
}

async function revokeConsent(config) {
  config.consent_granted = false;
  config.consent_version = "";
  config.consent_granted_at = 0;
  saveConfig(config);
  console.log("Consent revoked. To delete all learning data, contact support@webinarignition.com.");
}

async function main() {
  const args = process.argv.slice(2);
  let config = loadConfig();

  if (args.includes("--status")) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (args.includes("--revoke")) {
    await revokeConsent(config);
    return;
  }

  if (args.includes("--consent")) {
    const ok = await grantConsent(config);
    process.exit(ok ? 0 : 1);
  }

  // Interactive mode
  console.log("\n=== WI-MCP Setup ===\n");
  console.log(`Client ID: ${config.client_id}`);
  console.log(`Consent: ${config.consent_granted ? "Granted (v" + config.consent_version + ")" : "Not granted"}\n`);

  if (!config.consent_granted) {
    console.log(CONSENT_TEXT + "\n");
    const answer = await ask("Do you consent to anonymized learning? (yes/no): ");
    if (answer.toLowerCase() === "yes" || answer.toLowerCase() === "y") {
      config.consent_granted = true;
      config.consent_version = CONSENT_VERSION;
      config.consent_granted_at = Math.floor(Date.now() / 1000);
      saveConfig(config);
      console.log("\nConsent granted. You're all set!");
    } else {
      console.log("\nConsent not granted. The tools will still work but without learning.");
    }
  } else {
    const revoke = await ask("Revoke consent? (yes/no): ");
    if (revoke.toLowerCase() === "yes" || revoke.toLowerCase() === "y") {
      await revokeConsent(config);
    }
  }

  console.log("\nSetup complete. Start the MCP server with: npm start");
}

main().catch(console.error);
