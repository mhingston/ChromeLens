import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ActivityStore } from "../../../packages/database/src/index.ts";
import { discoverBrowserProfiles, importBrowserHistory } from "../../../packages/browser-history-import/src/index.ts";
import { GitOutputConnector } from "../../../packages/connectors/src/index.ts";
import { createCollectorServer } from "./server.ts";

const command = process.argv[2] ?? "serve";
const dataDirectory = resolve(process.env.CHROMELENS_DATA_DIR ?? join(homedir(), ".chromelens"));
await mkdir(dataDirectory, { recursive: true, mode: 0o700 });

if (command === "profiles") {
  const profiles = await discoverBrowserProfiles({ homeDir: homedir() });
  if (!profiles.length) console.log("No Chrome or Brave profiles found at standard locations.");
  else for (const profile of profiles) console.log(`${profile.profileId}\t${profile.historyPath}`);
} else if (command === "import") {
  const requested = process.argv[3];
  if (!requested) throw new Error("Usage: npm run import -- chrome:Default");
  const profiles = await discoverBrowserProfiles({ homeDir: homedir() });
  const profile = profiles.find((candidate) => candidate.profileId === requested);
  if (!profile) throw new Error(`Profile not found: ${requested}. Run npm run profiles first.`);
  const store = new ActivityStore(join(dataDirectory, "chromelens.sqlite"));
  try { console.log(JSON.stringify(await importBrowserHistory({ profile, store }), null, 2)); }
  finally { store.close(); }
} else if (command === "outputs") {
  const repositoryPath = process.argv[3];
  if (!repositoryPath) throw new Error("Usage: npm run outputs -- /path/to/repository [from-iso] [to-iso] [association-window-minutes]");
  const to = process.argv[5] ?? new Date().toISOString();
  const from = process.argv[4] ?? new Date(Date.parse(to) - 7 * 86_400_000).toISOString();
  const associationWindowMinutes = Number(process.argv[6] ?? 30);
  if (!Number.isFinite(associationWindowMinutes) || associationWindowMinutes < 0 || associationWindowMinutes > 1_440) {
    throw new Error("Association window must be between zero and 1440 minutes");
  }
  const store = new ActivityStore(join(dataDirectory, "chromelens.sqlite"));
  try {
    const outputs = await new GitOutputConnector(repositoryPath).collect({ from, to });
    const imported = store.importOutputs(outputs);
    const rebuilt = store.rebuildDerivations(undefined, { afterEpisodeMs: associationWindowMinutes * 60_000 });
    store.setSetting("gitConnector", { repositoryPath: resolve(repositoryPath), associationWindowMinutes });
    console.log(JSON.stringify({ collected: outputs.length, ...imported, ...rebuilt }, null, 2));
  } finally { store.close(); }
} else if (command === "serve") {
  const token = process.env.CHROMELENS_TOKEN ?? await loadOrCreateToken(join(dataDirectory, "collector-token"));
  const port = Number(process.env.CHROMELENS_PORT ?? 47_832);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("CHROMELENS_PORT must be a valid TCP port");
  const store = new ActivityStore(join(dataDirectory, "chromelens.sqlite"));
  const dashboardDir = resolve(process.cwd(), "dist/dashboard");
  const server = createCollectorServer({ store, token, host: "127.0.0.1", port, dashboardDir });
  const address = await server.start();
  console.log(`ChromeLens collector: ${address}`);
  console.log(`Dashboard: ${address}`);
  console.log(`Extension bearer token: ${token}`);
  console.log(`Data: ${join(dataDirectory, "chromelens.sqlite")}`);
  const shutdown = async () => { await server.stop(); store.close(); process.exit(0); };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
} else {
  throw new Error(`Unknown command: ${command}`);
}

async function loadOrCreateToken(path: string): Promise<string> {
  try {
    await access(path, constants.R_OK);
    return (await readFile(path, "utf8")).trim();
  } catch {
    const token = randomBytes(32).toString("base64url");
    await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return token;
  }
}
