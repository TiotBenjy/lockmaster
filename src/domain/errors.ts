// Erreurs typées de lockmaster (CLAUDE.md §Conventions) : un `code` stable, testé et documenté,
// et un message destiné à l'opérateur. Une erreur inattendue ne fuit jamais au client HTTP.

export class LockmasterError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LockmasterError';
    this.code = code;
  }
}
