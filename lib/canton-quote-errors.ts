export class CantonQuoteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CantonQuoteUnavailableError";
  }
}

export class CantonQuoteSanityError extends Error {
  readonly userMessage: string;

  constructor(detail: string, userMessage: string) {
    super(detail);
    this.name = "CantonQuoteSanityError";
    this.userMessage = userMessage;
  }
}
