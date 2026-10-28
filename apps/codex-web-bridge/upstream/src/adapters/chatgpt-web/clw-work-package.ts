import { readFileSync } from "node:fs";

/** CLW's user-selected workload; does not change transport or execution authority. */
export function clwWorkPackageGuidance(): string[] {
  const file = process.env.CLW_WEB_WORK_PACKAGE_FILE;
  if (!file) return [];
  const policy = JSON.parse(readFileSync(file, "utf8"));
  if (policy?.version !== 1 || typeof policy.text !== "string" || !policy.text.trim()) {
    throw new Error("work_package_policy_invalid");
  }
  return [policy.text.trim()];
}
