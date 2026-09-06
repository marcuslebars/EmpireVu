import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Calendar, CheckCircle2, DollarSign, Edit3, Loader2, Mail, MoreHorizontal, Phone, Star, Trash2, TrendingUp, X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  useAssignContactOwner,
  useDeleteContact,
  useOrgMembers,
  useUpdateContactFields,
  useUpdateContactStage,
} from "@/lib/api-hooks";
import { toast } from "@/components/ui/sonner";
import { Modal } from "@/components/ui/Modal";
import { formatCentsCompact } from "@/lib/format";
import type { ContactDetailResponse } from "@/lib/api-client";
import { VoicePanel } from "@/components/contact/VoicePanel";
import { actionTypeConfig, pipelineStageOrder, stageConfig, stageLabel } from "@/components/contact/config";

export function Header({
  orgId,
  detail,
  onEdit,
  onTakeAction,
}: {
  orgId: string;
  detail: ContactDetailResponse;
  onEdit: () => void;
  onTakeAction: () => void;
}) {
  const navigate = useNavigate();
  const { contact, financialSummary, nextAction, linkedBookings, linkedTasks } = detail;
  const updateStage = useUpdateContactStage(orgId);
  const assignOwner = useAssignContactOwner(orgId, contact.id);
  const deleteContact = useDeleteContact(orgId);
  const { data: members } = useOrgMembers(orgId);
  const [menuOpen, setMenuOpen] = useState(false);

  const sc = stageConfig[contact.stage] ?? stageConfig.lead;
  const ac = actionTypeConfig[nextAction.type];
  const isHighValue = (financialSummary.pipelineValueCents ?? 0) >= 2_500_000;
  const openTasks = linkedTasks.filter((t) => t.status !== "completed").length;
  const doneTasks = linkedTasks.filter((t) => t.status === "completed").length;
  const upcomingBookings = linkedBookings.filter((b) => b.status !== "completed").length;

  return (
    <div className="opacity-0 animate-fade-in">
      <button
        onClick={() => navigate("/crm")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 active:scale-[0.97]"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to CRM
      </button>

      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center text-base font-bold relative bg-primary/15 text-primary")}>
              {contact.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
              {isHighValue && (
                <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 flex items-center justify-center">
                  <Star className="w-2 h-2 text-amber-950" />
                </div>
              )}
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">{contact.name}</h1>
              <div className="flex items-center flex-wrap gap-3 mt-1.5">
                {contact.company && (
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-md inline-flex items-center gap-1.5 bg-primary/15 text-primary">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                    {contact.company.name}
                  </span>
                )}
                <select
                  value={contact.stage}
                  disabled={updateStage.isPending}
                  onChange={(e) =>
                    updateStage.mutate({
                      contactId: contact.id,
                      stage: e.target.value as "lead" | "qualified" | "active" | "closed",
                    })
                  }
                  className={cn(
                    "text-[11px] font-medium px-2 py-0.5 rounded-md border-none focus:ring-0 cursor-pointer disabled:opacity-60",
                    sc.bg,
                    sc.text,
                  )}
                  aria-label="Change stage"
                >
                  {pipelineStageOrder.map((s) => (
                    <option key={s} value={s}>{stageLabel[s]}</option>
                  ))}
                </select>
                {financialSummary.pipelineValueCents != null && (
                  <span className="text-sm font-bold text-foreground tabular-nums">
                    {formatCentsCompact(financialSummary.pipelineValueCents)}
                  </span>
                )}
              </div>
              <div className="flex items-center flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-muted-foreground">
                {contact.email && <span className="flex items-center gap-1.5"><Mail className="w-3 h-3" />{contact.email}</span>}
                {contact.phone && <span className="flex items-center gap-1.5"><Phone className="w-3 h-3" />{contact.phone}</span>}
                {contact.owner && <span className="flex items-center gap-1.5"><TrendingUp className="w-3 h-3" />Owner: {contact.owner.name}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <VoicePanel orgId={orgId} contact={contact} />
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
            >
              <Edit3 className="w-3 h-3" />
              Edit
            </button>
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute top-full right-0 mt-1 w-56 bg-popover border border-border rounded-lg shadow-xl z-50 p-2 animate-scale-in">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-1 pb-1">Owner</p>
                    <select
                      value={contact.owner?.id ?? ""}
                      onChange={(e) => { if (e.target.value) assignOwner.mutate(e.target.value); }}
                      disabled={assignOwner.isPending}
                      className="w-full bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30 mb-2 disabled:opacity-50"
                    >
                      <option value="" disabled>Unassigned</option>
                      {(members ?? []).map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        if (window.confirm(`Delete ${contact.name}? Linked bookings and tasks will be unlinked. This can't be undone.`)) {
                          deleteContact.mutate(contact.id, {
                            onSuccess: () => { toast.success("Contact deleted"); navigate("/crm"); },
                            onError: () => toast.error("Failed to delete contact."),
                          });
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete contact
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {ac && (
          <div className={cn("flex items-center gap-3 mt-4 p-3 rounded-lg border", ac.bg, ac.border)}>
            <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", ac.bg)}>
              <ac.icon className={cn("w-4 h-4", ac.text)} />
            </div>
            <div className="flex-1">
              <p className={cn("text-sm font-semibold", ac.text)}>Next: {nextAction.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{nextAction.detail}</p>
            </div>
            <button
              onClick={onTakeAction}
              className={cn("px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97]", ac.bg, ac.text, "hover:opacity-80")}
            >
              Take Action →
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-border/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Revenue</p>
              <p className="text-base font-bold text-foreground tabular-nums">{formatCentsCompact(financialSummary.realizedRevenueCents)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <Calendar className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Bookings</p>
              <div className="flex items-center gap-2">
                <p className="text-base font-bold text-foreground tabular-nums">{linkedBookings.length}</p>
                {upcomingBookings > 0 && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-primary/10 text-primary">{upcomingBookings} upcoming</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Tasks</p>
              <p className="text-base font-bold text-foreground tabular-nums">{openTasks} open · {doneTasks} done</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Owner</p>
              <p className="text-base font-bold text-foreground">{contact.owner?.name ?? "—"}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function EditContactDialog({
  orgId,
  contactId,
  initial,
  onClose,
}: {
  orgId: string;
  contactId: string;
  initial: { name: string; email: string | null; phone: string | null };
  onClose: () => void;
}) {
  const updateContact = useUpdateContactFields(orgId, contactId);
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const parts = name.trim().split(/\s+/);
    try {
      await updateContact.mutateAsync({
        firstName: parts[0],
        lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
        email: email.trim() || null,
        phone: phone.trim() || null,
      });
      toast.success("Contact updated");
      onClose();
    } catch {
      toast.error("Failed to update contact. Please try again.");
    }
  };

  return (
    <Modal onClose={onClose} size="md">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">Edit Contact</h2>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Name <span className="text-destructive">*</span></label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Phone</label>
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 000 0000" className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">Cancel</button>
          <button type="submit" disabled={updateContact.isPending || !name.trim()} className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]">
            {updateContact.isPending ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>) : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
