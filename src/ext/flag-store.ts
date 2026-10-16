/** Where a demo's flags live and how they are read — on its own so that
    `verify` (which checks them) and `flags` (which raises them, and asks
    `verify` to judge) do not import each other. */
import fs from "node:fs";

export type Flag = {
  /** Short and stable: scene + a slug of the expectation. Survives a
      re-record, which "the price thing" does not. */
  id: string;
  scene: string;
  /** What was originally raised, in the words it was raised in. */
  question: string;
  /** What has to be true now — the sentence written into the manifest. */
  expect: string;
  flaggedAt: string;
  source: "sense" | "verify" | "you";
};

export const flagsPath = (manifestFile: string) => manifestFile.replace(/\.(ya?ml|json)$/i, "") + ".flags.json";

export function readFlags(manifestFile: string): Flag[] {
  try {
    const v = JSON.parse(fs.readFileSync(flagsPath(manifestFile), "utf8")) as { flags?: Flag[] };
    return Array.isArray(v.flags) ? v.flags : [];
  } catch { return []; }
}
