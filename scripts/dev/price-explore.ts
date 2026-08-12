/* Dev-only: explore @a1/pricing-engine storage subtotals to ground Phase 2 anchors. */
import { calculateQuote } from "@a1/pricing-engine";

const d = (c: number) => `$${(c / 100).toFixed(2)}`;

function show(label: string, input: Parameters<typeof calculateQuote>[0]) {
  const r = calculateQuote(input);
  const total = r.subtotalCents + Math.round(r.subtotalCents * 0.13);
  const deposit = Math.round(total * 0.25);
  console.log(
    `${label.padEnd(52)} subtotal=${d(r.subtotalCents).padStart(10)}  +HST=${d(total).padStart(10)}  dep25%=${d(deposit).padStart(9)}`,
  );
}

const win = (t: "outboard" | "sterndrive" | "inboard", n = 1) => ({
  serviceId: `winterization_${t}`,
  engineType: t,
  engineCount: n,
});

console.log("--- 24ft configs ---");
show("24ft outdoor+shrink+wint(ob) a la carte", {
  serviceLine: "storage",
  items: [{ serviceId: "outdoor_storage", lengthFt: 24 }, { serviceId: "shrink_wrap", lengthFt: 24 }, win("outboard")],
});
show("24ft same, winter_ready_plus bundle", {
  serviceLine: "storage",
  bundleId: "winter_ready_plus",
  items: [{ serviceId: "outdoor_storage", lengthFt: 24 }, { serviceId: "shrink_wrap", lengthFt: 24 }, win("outboard")],
});
show("24ft +fall_detail a la carte", {
  serviceLine: "storage",
  items: [{ serviceId: "outdoor_storage", lengthFt: 24 }, { serviceId: "shrink_wrap", lengthFt: 24 }, win("outboard"), { serviceId: "fall_detail", lengthFt: 24 }],
});
show("24ft pontoon outdoor+shrink+wint(ob)", {
  serviceLine: "storage",
  hullType: "pontoon",
  items: [{ serviceId: "outdoor_storage", lengthFt: 24 }, { serviceId: "shrink_wrap", lengthFt: 24 }, win("outboard")],
});
show("24ft full_care (ob) bundle", {
  serviceLine: "storage",
  bundleId: "full_care",
  items: [{ serviceId: "outdoor_storage", lengthFt: 24 }, { serviceId: "shrink_wrap", lengthFt: 24 }, win("outboard"), { serviceId: "fall_detail", lengthFt: 24 }, { serviceId: "spring_commissioning" }],
});

console.log("--- length sweep: outdoor+shrink+wint(sterndrive,2) a la carte ---");
for (const L of [28, 30, 32, 34, 36, 38, 40, 42, 45]) {
  show(`${L}ft outdoor+shrink+wint(sd,2)`, {
    serviceLine: "storage",
    items: [{ serviceId: "outdoor_storage", lengthFt: L }, { serviceId: "shrink_wrap", lengthFt: L }, win("sterndrive", 2)],
  });
}

console.log("--- full_care sweep (inboard twin) ---");
for (const L of [36, 38, 40, 42, 45]) {
  show(`${L}ft full_care (ib,2)`, {
    serviceLine: "storage",
    bundleId: "full_care",
    items: [{ serviceId: "outdoor_storage", lengthFt: L }, { serviceId: "shrink_wrap", lengthFt: L }, win("inboard", 2), { serviceId: "fall_detail", lengthFt: L }, { serviceId: "spring_commissioning" }],
  });
}
