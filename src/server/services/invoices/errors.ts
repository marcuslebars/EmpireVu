import { UserFacingError } from "@/server/errors";
import { ValidationError } from "@/server/organizations/context";

/** A request that names something that isn't there (→ 404). */
export class InvoiceNotFoundError extends UserFacingError {
  constructor(message = "Invoice not found.") {
    super(message, { status: 404 });
    this.name = "InvoiceNotFoundError";
  }
}

/**
 * A legal request in the wrong state (→ 409): editing a paid invoice, voiding one
 * with money against it, invoicing a quote twice. `existingInvoiceId` is set when
 * the conflict is "this is already invoiced", so the UI can open that invoice.
 */
export class InvoiceConflictError extends UserFacingError {
  constructor(
    message: string,
    readonly existingInvoiceId: string | null = null,
    code?: string,
  ) {
    super(message, { status: 409, code, details: existingInvoiceId ? { existingInvoiceId } : undefined });
    this.name = "InvoiceConflictError";
  }
}

/** Bad input (→ 400 via handleRoute). */
export class InvoiceValidationError extends ValidationError {}
