import type { Page } from "playwright";

export type ActionProofState = "visible" | "hidden" | "active" | "checked" | "text" | "attribute";

export type ActionProofSpec = {
  selector: string;
  state: ActionProofState;
  value?: string;
  attribute?: string;
  change: boolean;
  timeout: number;
};

export type ActionProofSnapshot = {
  found: boolean;
  visible: boolean;
  classTokens: string[];
  attributes: Record<string, string | null>;
  text: string;
  checked: boolean;
};

export type ActionProofAssessment = { ok: boolean; reason: string };

export function proofMatches(spec: ActionProofSpec, snapshot: ActionProofSnapshot): boolean {
  switch (spec.state) {
    case "visible": return snapshot.found && snapshot.visible;
    case "hidden": return !snapshot.found || !snapshot.visible;
    case "active":
      return snapshot.found && snapshot.visible && (
        snapshot.classTokens.some((token) => /(^|[-_])(active|selected|current|checked)([-_]|$)/i.test(token)) ||
        snapshot.attributes["aria-selected"] === "true" ||
        snapshot.attributes["aria-pressed"] === "true" ||
        snapshot.attributes["data-state"] === "active" ||
        snapshot.checked
      );
    case "checked": return snapshot.found && snapshot.checked;
    case "text": return snapshot.found && snapshot.text.includes(spec.value ?? "");
    case "attribute": return snapshot.found && snapshot.attributes[spec.attribute ?? ""] === spec.value;
  }
}

export function assessActionProof(
  spec: ActionProofSpec,
  before: ActionProofSnapshot,
  after: ActionProofSnapshot,
): ActionProofAssessment {
  if (spec.change && proofMatches(spec, before)) {
    return { ok: false, reason: `proof already satisfied before the action: ${describeProof(spec)}; choose an action that visibly changes state` };
  }
  if (!proofMatches(spec, after)) {
    return { ok: false, reason: `proof not satisfied after the action: ${describeProof(spec)}` };
  }
  return { ok: true, reason: "" };
}

export async function snapshotActionProof(page: Page, spec: ActionProofSpec): Promise<ActionProofSnapshot> {
  const locator = page.locator(spec.selector).first();
  const found = await locator.count().then((count) => count > 0).catch(() => false);
  if (!found) return emptySnapshot();
  const visible = await locator.isVisible().catch(() => false);
  return locator.evaluate((element) => {
    const input = element as HTMLInputElement;
    const attributes: Record<string, string | null> = {};
    for (const name of ["aria-selected", "aria-pressed", "data-state"]) attributes[name] = element.getAttribute(name);
    for (const attribute of Array.from(element.attributes)) attributes[attribute.name] = attribute.value;
    return {
      found: true,
      visible: true,
      classTokens: Array.from(element.classList),
      attributes,
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
      checked: "checked" in input ? Boolean(input.checked) : false,
    };
  }).then((snapshot) => ({ ...snapshot, visible })).catch(() => ({ ...emptySnapshot(), found, visible }));
}

export async function waitForActionProof(page: Page, spec: ActionProofSpec): Promise<ActionProofSnapshot> {
  const deadline = Date.now() + spec.timeout;
  let latest = await snapshotActionProof(page, spec);
  while (!proofMatches(spec, latest) && Date.now() < deadline) {
    await page.waitForTimeout(100);
    latest = await snapshotActionProof(page, spec);
  }
  return latest;
}

export function describeProof(spec: ActionProofSpec): string {
  if (spec.state === "text") return `${spec.selector} contains text ${JSON.stringify(spec.value ?? "")}`;
  if (spec.state === "attribute") return `${spec.selector} has ${spec.attribute}=${JSON.stringify(spec.value ?? "")}`;
  return `${spec.selector} is ${spec.state}`;
}

function emptySnapshot(): ActionProofSnapshot {
  return { found: false, visible: false, classTokens: [], attributes: {}, text: "", checked: false };
}
