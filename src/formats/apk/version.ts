// Versions APK (format Gentoo : `{chiffres}{.chiffres}...{lettre}{_suffixe{n}}...{-rN}`). Comparaison
// qui reproduit le découpage en jetons d'apk-tools 2.14 (src/version.c) : nombres après un point
// comptés négativement par leurs zéros de tête, une lettre après des chiffres, suffixes `_alpha`
// < `_beta` < `_pre` < `_rc` < (rien) < `_cvs` < `_svn` < `_git` < `_hg` < `_p`, révision `-rN`.
// Validation : grammaire stricte ci-dessus, plus les bornes d'apk (nombres de moins de 18 chiffres).

import { atNumber } from '../common/bytes.js';
import { FormatError } from '../common/errors.js';

const GRAMMAR = /^\d+(?:\.\d+)*[a-z]?(?:_(?:alpha|beta|pre|rc|cvs|svn|git|hg|p)\d*)*(?:-r\d+)?$/;
const MAX_DIGITS = 17;
const SUFFIXES = ['alpha', 'beta', 'pre', 'rc', 'cvs', 'svn', 'git', 'hg', 'p'];
const SUFFIX_LENGTHS = SUFFIXES.map((suffix) => suffix.length);
const PRE_SUFFIX_COUNT = 4;
const isDigitCode = (code: number): boolean => code >= 0x30 && code <= 0x39;

/** Ordre des jetons d'apk (enum PARTS) : un rang plus élevé est « plus tôt » dans la comparaison finale. */
enum Token {
  DigitOrZero = 0,
  Digit = 1,
  Letter = 2,
  Suffix = 3,
  SuffixNumber = 4,
  RevisionNumber = 5,
  End = 6,
}

export function isValidApkVersion(version: string): boolean {
  return GRAMMAR.test(version) && version.split(/\D+/).every((run) => run.length <= MAX_DIGITS);
}

/** Négatif, nul ou positif ; lève FORMAT_INVALID si l'une des versions est invalide. */
export function compareApkVersion(a: string, b: string): number {
  if (!isValidApkVersion(a) || !isValidApkVersion(b)) throw new FormatError('FORMAT_INVALID', 'version APK invalide');
  const left = new Tokenizer(a);
  const right = new Tokenizer(b);
  let leftValue = 0;
  let rightValue = 0;
  while (left.type === right.type && left.type !== Token.End && leftValue === rightValue) {
    leftValue = left.next();
    rightValue = right.next();
  }
  if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  if (left.type === right.type) return 0;
  // Composants égaux : la version qui continue est plus récente, sauf si elle continue par un
  // suffixe de pré-version (valeur négative).
  if (left.type === Token.Suffix && left.peekSuffix() < 0) return -1;
  if (right.type === Token.Suffix && right.peekSuffix() < 0) return 1;
  return left.type > right.type ? -1 : 1;
}

class Tokenizer {
  readonly #text: string;
  #position = 0;
  type: Token = Token.Digit;

  constructor(text: string) {
    this.#text = text;
  }

  /** Valeur du jeton courant, puis passage au suivant (get_token). */
  next(): number {
    let value: number;
    let forced: Token | undefined;
    if (this.type === Token.DigitOrZero && this.#text[this.#position] === '0') {
      // Zéros de tête après un point : valeur = -(zéros en plus du premier) ; le dernier zéro reste et
      // se lit avec le nombre (« 1.005 » donne -1 puis 5, comme get_token).
      let zeros = 0;
      while (this.#text[this.#position + zeros + 1] === '0') zeros += 1;
      this.#position += zeros;
      value = -zeros;
      forced = Token.Digit;
    } else if (this.type === Token.Letter) {
      value = this.#text.charCodeAt(this.#position);
      this.#position += 1;
    } else if (this.type === Token.Suffix) {
      value = this.#readSuffix();
    } else {
      const start = this.#position;
      while (this.#position < this.#text.length && isDigitCode(this.#text.charCodeAt(this.#position)))
        this.#position += 1;
      value = Number(this.#text.slice(start, this.#position));
    }
    if (this.#position >= this.#text.length) this.type = Token.End;
    else if (forced !== undefined) this.type = forced;
    else this.#advance();
    return value;
  }

  /** Valeur du suffixe courant sans avancer. */
  peekSuffix(): number {
    const saved = this.#position;
    const value = this.#readSuffix();
    this.#position = saved;
    return value;
  }

  /** Suffixe (`pre` cherché avant `p`, comme get_token) : pré-versions -4 à -1, post-versions 0 à 4. */
  #readSuffix(): number {
    const rest = this.#text.slice(this.#position);
    const index = SUFFIXES.findIndex((suffix) => rest.startsWith(suffix));
    this.#position += atNumber(SUFFIX_LENGTHS, index);
    return index - PRE_SUFFIX_COUNT;
  }

  /** next_token : type du jeton suivant d'après le caractère courant et le type précédent. */
  #advance(): void {
    const char = this.#text.charAt(this.#position);
    const isDigit = char >= '0' && char <= '9';
    if ((this.type === Token.Digit || this.type === Token.DigitOrZero) && char >= 'a' && char <= 'z') {
      this.type = Token.Letter;
    } else if (this.type === Token.Suffix && isDigit) {
      this.type = Token.SuffixNumber;
    } else {
      this.type = char === '.' ? Token.DigitOrZero : char === '_' ? Token.Suffix : Token.RevisionNumber;
      this.#position += char === '-' ? 2 : 1;
    }
  }
}
