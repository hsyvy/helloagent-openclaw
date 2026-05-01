/**
 * Persists per-account HelloAgent credentials to disk.
 *
 * Layout:
 *   <stateDir>/credentials/helloagent/<accountId>/creds.json
 *   <stateDir>/credentials/helloagent/<accountId>/creds.json.bak
 *
 * stateDir defaults to ~/.openclaw and can be overridden via:
 *   - OPENCLAW_OAUTH_DIR (full path to the credentials dir)
 *   - OPENCLAW_STATE_DIR (parent dir; we append /credentials)
 *   - HELLOAGENT_AUTH_DIR (full path to the helloagent provider dir; test override)
 *
 * Atomic writes: temp file + rename + chmod 0600 on the backup.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CREDS_VERSION = 1;
export const DEFAULT_ACCOUNT_ID = "default";

export type HelloAgentCreds = {
  version: number;
  handle: string;
  agentName: string;
  ownerHandle: string;
  token: string;
  apiUrl: string;
  relayWs: string;
  linkedAt: string;
  source?: "oauth" | "device" | "manual";
};

export function resolveStateDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return explicit;
  return path.join(os.homedir(), ".openclaw");
}

export function resolveOAuthDir(): string {
  const explicit = process.env.OPENCLAW_OAUTH_DIR?.trim();
  if (explicit) return explicit;
  return path.join(resolveStateDir(), "credentials");
}

export function resolveHelloAgentAuthDir(): string {
  const explicit = process.env.HELLOAGENT_AUTH_DIR?.trim();
  if (explicit) return explicit;
  return path.join(resolveOAuthDir(), "helloagent");
}

export function accountAuthDir(accountId: string = DEFAULT_ACCOUNT_ID): string {
  return path.join(resolveHelloAgentAuthDir(), accountId);
}

function credsPath(accountId: string = DEFAULT_ACCOUNT_ID): string {
  return path.join(accountAuthDir(accountId), "creds.json");
}

function backupPath(accountId: string = DEFAULT_ACCOUNT_ID): string {
  return path.join(accountAuthDir(accountId), "creds.json.bak");
}

export async function readCreds(accountId: string = DEFAULT_ACCOUNT_ID): Promise<HelloAgentCreds | null> {
  try {
    const raw = await fs.readFile(credsPath(accountId), "utf-8");
    const parsed = JSON.parse(raw) as HelloAgentCreds;
    if (parsed.version !== CREDS_VERSION) {
      throw new Error(`unsupported creds version: ${parsed.version}`);
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeCreds(
  creds: HelloAgentCreds,
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<void> {
  const dir = accountAuthDir(accountId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const final = credsPath(accountId);
  const tmp = `${final}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(creds, null, 2) + "\n";
  await fs.writeFile(tmp, payload, { mode: 0o600 });

  try {
    const existing = await fs.readFile(final);
    await fs.writeFile(backupPath(accountId), existing, { mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await fs.rename(tmp, final);
  await fs.chmod(final, 0o600);
}

export async function deleteCreds(accountId: string = DEFAULT_ACCOUNT_ID): Promise<void> {
  for (const p of [credsPath(accountId), backupPath(accountId)]) {
    try {
      await fs.unlink(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

export async function listLinkedAccountIds(): Promise<string[]> {
  const dir = resolveHelloAgentAuthDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const linked: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(dir, entry.name, "creds.json"));
      linked.push(entry.name);
    } catch {
      /* missing creds.json, skip */
    }
  }
  return linked;
}
