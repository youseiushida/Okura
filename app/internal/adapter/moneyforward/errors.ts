export class MoneyForwardError extends Error {
  override name = "MoneyForwardError";
}

export class AuthenticationFailedError extends MoneyForwardError {
  override name = "MoneyForwardAuthenticationFailedError";
}

export class VerificationFailedError extends AuthenticationFailedError {
  override name = "MoneyForwardVerificationFailedError";
}

export class UnauthenticatedError extends AuthenticationRequiredError {
  override name = "MoneyForwardUnauthenticatedError";

  constructor() {
    super("moneyforward", "Money Forward authentication is required");
  }
}

export class UnexpectedPageError extends MoneyForwardError {
  override name = "MoneyForwardUnexpectedPageError";
}

export class ParseError extends MoneyForwardError {
  override name = "MoneyForwardParseError";
}
import { AuthenticationRequiredError } from "../../port/source.ts";
