/**
 * Customer picker for the quote builder: search existing contacts (same picker as
 * the invoice editor) or quick-add a new one, which is created and then selected.
 */
import { useId, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";

import { ContactSearch } from "@/components/invoices/InvoiceEditorDialog";
import { errorMessage, inputCls, labelCls, primaryBtnCls, secondaryBtnCls } from "@/components/invoices/invoice-ui";
import { toast } from "@/components/ui/sonner";
import { useCreateContact } from "@/lib/api-hooks";
import { cn } from "@/lib/utils";

import { errorBoxCls } from "./quote-ui";

function createdId(result: unknown): string | null {
  if (result && typeof result === "object" && "id" in result) {
    const id = (result as { id: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

export function QuoteCustomerField({
  orgId,
  companyId,
  contactId,
  contactLabel,
  onChange,
}: {
  orgId: string;
  companyId: string;
  contactId: string | null;
  contactLabel: string;
  onChange: (id: string | null, label: string) => void;
}) {
  const createContact = useCreateContact(orgId);
  const [adding, setAdding] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  const reset = () => {
    setFirstName("");
    setLastName("");
    setEmail("");
    setPhone("");
    setError(null);
  };

  async function save() {
    setError(null);
    if (!companyId) return setError("Choose the company first.");
    if (!firstName.trim()) return setError("First name is required.");
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) return setError("That email address doesn't look right.");
    try {
      const result = await createContact.mutateAsync({
        companyId,
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
      });
      const id = createdId(result);
      if (!id) throw new Error("The contact was created but no id came back — search for them instead.");
      onChange(id, [firstName.trim(), lastName.trim()].filter(Boolean).join(" "));
      toast.success("Customer added");
      reset();
      setAdding(false);
    } catch (err) {
      setError(errorMessage(err, "Couldn't add the customer."));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted-foreground" id={`${ids}-label`}>
          Customer
        </span>
        {!contactId && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            <UserPlus className="w-3.5 h-3.5" /> New customer
          </button>
        )}
      </div>

      {adding ? (
        <div className="rounded-xl border border-border bg-secondary/20 p-3 space-y-3" role="group" aria-labelledby={`${ids}-label`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${ids}-first`} className={labelCls}>
                First name <span className="text-destructive">*</span>
              </label>
              <input id={`${ids}-first`} autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={100} className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${ids}-last`} className={labelCls}>
                Last name
              </label>
              <input id={`${ids}-last`} value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={100} className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${ids}-email`} className={labelCls}>
                Email
              </label>
              <input
                id={`${ids}-email`}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="The quote is emailed here"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor={`${ids}-phone`} className={labelCls}>
                Phone
              </label>
              <input id={`${ids}-phone`} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={50} className={inputCls} />
            </div>
          </div>
          {error && (
            <div className={errorBoxCls} role="alert">
              {error}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                reset();
                setAdding(false);
              }}
              className={secondaryBtnCls}
            >
              Cancel
            </button>
            <button type="button" onClick={() => void save()} disabled={createContact.isPending} className={primaryBtnCls}>
              {createContact.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Add customer
            </button>
          </div>
        </div>
      ) : (
        <div aria-labelledby={`${ids}-label`} role="group" className={cn(!companyId && "opacity-60 pointer-events-none")}>
          <ContactSearch orgId={orgId} value={contactId} label={contactLabel} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
