import { CallAnsweringSettingsSection } from "@/components/settings/CallAnsweringSettingsSection";
import { OwnerPhoneSettingsSection } from "@/components/settings/OwnerPhoneSettingsSection";
import { WeeklyReportSettingsSection } from "@/components/settings/WeeklyReportSettingsSection";
import type { AiFrontDeskSlot } from "@/components/settings/AiFrontDeskSettings";
import { BookkeeperSettingsSection } from "@/components/settings/staff/BookkeeperSettingsSection";
import { DispatcherSettingsSection } from "@/components/settings/staff/DispatcherSettingsSection";
import { EstimatorSettingsSection } from "@/components/settings/staff/EstimatorSettingsSection";
import { MarketerSettingsSection } from "@/components/settings/staff/MarketerSettingsSection";

/**
 * The sections that follow "Text conversations" in Settings → AI front desk, in order:
 * Phone answering, Weekly report, then the owner's cell for owner texts. Kept apart from AiFrontDeskSettings.tsx so the section
 * files can use its shared card frame without an import cycle.
 */
export const AI_FRONT_DESK_SECTIONS: AiFrontDeskSlot[] = [
  {
    id: "call-answering",
    render: ({ orgId, companyId, canManage }) => <CallAnsweringSettingsSection orgId={orgId} companyId={companyId} canManage={canManage} />,
  },
  {
    id: "weekly-report",
    render: ({ orgId, companyId }) => <WeeklyReportSettingsSection organizationId={orgId} companyId={companyId} />,
  },
  {
    id: "owner-phone",
    render: (props) => <OwnerPhoneSettingsSection {...props} />,
  },
  // AI staff (docs/ai-staff.md) — each role owns its section file.
  { id: "estimator", render: (props) => <EstimatorSettingsSection {...props} /> },
  { id: "bookkeeper", render: (props) => <BookkeeperSettingsSection {...props} /> },
  { id: "dispatcher", render: (props) => <DispatcherSettingsSection {...props} /> },
  { id: "marketer", render: (props) => <MarketerSettingsSection {...props} /> },
];
