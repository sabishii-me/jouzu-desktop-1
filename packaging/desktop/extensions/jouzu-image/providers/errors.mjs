// One set of reason codes for every image provider. The desktop words each
// code in its own language; the text is the English line, and `detail` keeps
// what the service said, for Details.
export const CODES = ["sign-in-refused", "no-credit", "not-allowed", "unreachable", "busy", "other"];

export function coded(code, text, detail) {
  return Object.assign(new Error(text), { code: CODES.includes(code) ? code : "other", ...(detail ? { detail } : {}) });
}

/** The code of any error: a provider's own, else `other`. */
export function codeOf(error) {
  return CODES.includes(error?.code) ? error.code : "other";
}
