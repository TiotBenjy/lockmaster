// Caractères refusés dans tout champ republié (docs/02 §3.2) : contrôles C0 (sauf saut de ligne et
// tabulation quand le champ les admet), DEL, C1, et les non-caractères U+FFFE et U+FFFF, interdits en
// XML 1.0 même échappés (un seul champ rendrait invalides primary.xml ou filelists.xml).

export interface TextRules {
  readonly newline?: boolean;
  readonly tab?: boolean;
}

export function hasForbiddenCharacter(value: string, rules: TextRules = {}): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0a ? !rules.newline : code === 0x09 ? !rules.tab : isForbidden(code)) return true;
  }
  return false;
}

function isForbidden(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffe || code === 0xffff;
}
