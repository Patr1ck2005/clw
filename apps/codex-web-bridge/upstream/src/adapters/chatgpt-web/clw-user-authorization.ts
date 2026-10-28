import { readFileSync, lstatSync } from "node:fs";

/** Opt-in CLW user consent, distinct from platform authority and tool permissions. */
export function clwUserAuthorization(): string[] {
  const file = process.env.CLW_WEB_AUTHORIZATION_FILE;
  if (!file) return [];
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { lstatSync(file); }
    catch (check) { if ((check as NodeJS.ErrnoException).code === "ENOENT") return []; throw check; }
    throw error;
  }
  const policy = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.version !== 1 || typeof policy.enabled !== "boolean" ||
      ["recover_ended_turns", "auto_approve_returned_files", "auto_approve_tools"].some(key => Object.hasOwn(policy, key) && typeof policy[key] !== "boolean")) {
    throw new Error("web_user_authorization_invalid");
  }
  if (!policy.enabled) return [];
  if (typeof policy.text !== "string" || !policy.text.trim() || policy.text.length > 4096) {
    throw new Error("web_user_authorization_invalid");
  }
  return [policy.text.trim()];
}
