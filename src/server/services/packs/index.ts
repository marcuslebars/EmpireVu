import { generalContractorPack } from "@/server/services/packs/general-contractor";
import { hvacPlumbingPack } from "@/server/services/packs/hvac-plumbing";
import { landscapingPack } from "@/server/services/packs/landscaping";
import { marinePack } from "@/server/services/packs/marine";
import { propertyMaintenanceSnowPack } from "@/server/services/packs/property-maintenance-snow";
import { roofingPack } from "@/server/services/packs/roofing";
import type { IndustryPack, PackReceptionist } from "@/server/services/packs/types";
import type { ReceptionistPackNotes } from "@/server/services/retell/provision";

/** The shipped packs. Order = display order in the picker. */
export const ALL_PACKS: readonly IndustryPack[] = [
  propertyMaintenanceSnowPack,
  landscapingPack,
  roofingPack,
  hvacPlumbingPack,
  marinePack,
  generalContractorPack,
];

const PACKS_BY_ID = new Map(ALL_PACKS.map((pack) => [pack.id, pack]));

/** A pack by id, or null for an unknown id. (Every pack is schema-validated in src/test/industry-packs.test.ts.) */
export function getPack(id: string): IndustryPack | null {
  return PACKS_BY_ID.get(id) ?? null;
}

/** The receptionist-prompt notes for a pack (pure mapping onto the prompt builder's input). */
export function packReceptionistNotes(pack: { name: string; receptionist: PackReceptionist }): ReceptionistPackNotes {
  return { packName: pack.name, ...pack.receptionist };
}

export type { IndustryPack } from "@/server/services/packs/types";
