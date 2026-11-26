/** How a native demo points at a control: the same role-and-name form
    Playwright uses on the web, so an agent learns one way to write a target.

      role=button[name="Sign in"]
      role=textbox[name="E-mail"] >> nth=1      the second of several

    An app has no CSS: what it does have is the accessibility tree, where every
    control is a role and a name. The roles are the web's words, mapped to the
    accessibility roles macOS uses; an `AX…` role is accepted as written for
    anything the map does not cover. */

export type NativeTarget = { role: string; name?: string; nth?: number };

/** Web role → the macOS accessibility roles it matches. */
export const NATIVE_ROLES: Record<string, string[]> = {
  button: ["AXButton"],
  checkbox: ["AXCheckBox"],
  radio: ["AXRadioButton"],
  textbox: ["AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField"],
  combobox: ["AXComboBox", "AXPopUpButton"],
  link: ["AXLink"],
  menuitem: ["AXMenuItem", "AXMenuBarItem"],
  tab: ["AXRadioButton", "AXTab"],
  slider: ["AXSlider"],
  text: ["AXStaticText"],
  heading: ["AXHeading"],
  image: ["AXImage"],
  row: ["AXRow"],
  cell: ["AXCell"],
  list: ["AXList", "AXOutline", "AXTable"],
  window: ["AXWindow"],
};

const TARGET = /^role=([A-Za-z]+)(?:\[name=(["'])(.*?)\2\])?(?:\s*>>\s*nth=(\d+))?$/;

export function parseNativeTarget(s: string): NativeTarget | null {
  const m = TARGET.exec(s.trim());
  if (!m) return null;
  const role = m[1];
  if (!NATIVE_ROLES[role] && !/^AX[A-Z][A-Za-z]+$/.test(role)) return null;
  return { role, ...(m[3] !== undefined ? { name: m[3] } : {}), ...(m[4] !== undefined ? { nth: Number(m[4]) } : {}) };
}

/** Why a string is not a native target, in words an agent can act on. */
export function nativeTargetProblem(s: string): string | null {
  if (parseNativeTarget(s)) return null;
  const role = /^role=([A-Za-z]+)/.exec(s.trim())?.[1];
  if (role && !NATIVE_ROLES[role] && !/^AX/.test(role)) {
    return `"${role}" is not a role Retake knows in an app. Use one of: ${Object.keys(NATIVE_ROLES).join(", ")}, or an accessibility role as written (e.g. AXDisclosureTriangle)`;
  }
  return `"${s}" is not an app target. An app has no CSS: write role=<role>[name="<name>"], e.g. role=button[name="Sign in"] (add >> nth=1 for the second of several). \`retake demo scout --app\` prints them`;
}

/** The internal address of an app demo. Everything that groups or names
    demos by where they point (the window's library, locks, heal) reads it
    the same way it reads a URL. */
export const appAddress = (app: string) => `app://${encodeURIComponent(app)}`;
export const isAppAddress = (url: string) => url.startsWith("app://");
