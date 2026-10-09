import { useState } from "react";
import { BadgeCheck, Loader2, Smartphone } from "lucide-react";

import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";
import { toast } from "@/components/ui/sonner";
import { useOwnerPhone, useOwnerPhoneActions } from "@/lib/front-desk-api";

function pretty(phone: string | null): string {
  const d = (phone ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : phone ?? "";
}

/**
 * Settings → AI front desk → Owner's cell. Approvals ("Reply Y 12") and commands ("move Jamie to
 * Friday") are only taken from this number, so changing it needs the 6-digit code we text to the
 * new number (owner-channel/owner-phone.ts).
 */
export function OwnerPhoneSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const { data, isLoading, isError } = useOwnerPhone(orgId, companyId);
  const { sendCode, verify } = useOwnerPhoneActions(orgId, companyId);
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const manage = canManage && (data?.canManage ?? false);
  const waiting = Boolean(data?.pendingPhone);

  const onSend = (to: string) =>
    sendCode.mutate(to, {
      onSuccess: () => toast.success("Code sent"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't send the code"),
    });
  const onVerify = () =>
    verify.mutate(code.trim(), {
      onSuccess: () => {
        toast.success("Phone confirmed");
        setEditing(false);
        setCode("");
        setPhone("");
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "That code didn't work"),
    });

  return (
    <AiFrontDeskSectionCard
      icon={<Smartphone className="w-4 h-4" />}
      title="Your cell for owner texts"
      description="Approvals (Reply Y) and commands by text are only taken from this number. Changing it needs a code we text to the new number."
      aside={
        data?.verified ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <BadgeCheck className="w-4 h-4" /> Confirmed
          </span>
        ) : null
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">Couldn't load this.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-foreground">
            {data.phone ? pretty(data.phone) : "No number on file."}
            {data.phone && !data.verified ? <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">Not confirmed - owner texts are off until it is.</span> : null}
          </p>

          {manage && (waiting || editing || (data.phone && !data.verified) || !data.phone) ? (
            <div className="space-y-2">
              {!waiting ? (
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onSend(phone.trim() || data.phone || "");
                  }}
                >
                  <input
                    className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                    inputMode="tel"
                    placeholder={data.phone ? pretty(data.phone) : "(705) 555-1234"}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    aria-label="Cell number"
                  />
                  <button
                    type="submit"
                    disabled={sendCode.isPending || !(phone.trim() || data.phone)}
                    className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
                  >
                    {sendCode.isPending ? "Sending…" : "Text me a code"}
                  </button>
                </form>
              ) : (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onVerify();
                  }}
                >
                  <span className="text-xs text-muted-foreground w-full">We texted a 6-digit code to {pretty(data.pendingPhone)}.</span>
                  <input
                    className="h-9 w-32 rounded-md border border-border bg-background px-3 text-sm tracking-widest"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    aria-label="Code"
                  />
                  <button
                    type="submit"
                    disabled={verify.isPending || code.trim().length !== 6}
                    className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
                  >
                    {verify.isPending ? "Checking…" : "Confirm"}
                  </button>
                  <button type="button" className="text-xs text-muted-foreground underline" onClick={() => onSend(data.pendingPhone ?? "")}>
                    Send again
                  </button>
                </form>
              )}
            </div>
          ) : manage ? (
            <button type="button" className="text-sm text-primary underline" onClick={() => setEditing(true)}>
              Change number
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>
          )}
        </div>
      )}
    </AiFrontDeskSectionCard>
  );
}
