import { useDevice } from "@m/state/device";
import type { DevicePrefs } from "@m/lib/native";
import { Screen } from "@m/ui/Screen";
import { Section, Segmented, Switch } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";
import { brand } from "@m/lib/brand";

const ROWS: Array<{ id: keyof DevicePrefs; label: string; sub: string }> = [
  { id: "compact", label: "Compact cards", sub: "More rows per screen" },
  { id: "revenue", label: "Show revenue on Home", sub: "Hide when handing the phone over" },
  { id: "badges", label: "Tab badges", sub: "Counts on Inbox and Tasks" },
  { id: "haptics", label: "Haptics", sub: "On complete, approve and send" },
];

export function Appearance() {
  const { prefs, setPref } = useDevice();
  const toast = useToast();

  return (
    <Screen title="Appearance">
      <Section title="Theme">
        <Segmented options={["Dark", "Light", "System"] as const} value="Dark" onChange={(t) => t !== "Dark" && toast(`${t} theme isn't available yet`)} />
        <p className="fine" style={{ fontSize: 11.5 }}>{brand.name} ships dark. Light is on the roadmap; System follows the device once it lands.</p>
      </Section>
      <Section title="This phone">
        <div className="list">
          {ROWS.map((row) => (
            <div key={row.id} className="row" style={{ padding: 14 }}>
              <span className="grow">
                <span className="row-title" style={{ fontSize: 12.5 }}>{row.label}</span>
                <span className="row-sub" style={{ fontSize: 10.5 }}>{row.sub}</span>
              </span>
              <Switch on={prefs[row.id]} label={row.label} onChange={(next) => setPref(row.id, next)} />
            </div>
          ))}
        </div>
      </Section>
    </Screen>
  );
}
