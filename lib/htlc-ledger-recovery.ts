import { toBaseUnitsFloor } from "./amount-units";
import type { InstrumentId } from "./constants";

type CreatedContract = {
  contractId?: string;
  templateId?: string;
  createdEventBlob?: string;
  createArgument?: unknown;
};

function createdContracts(
  eventsById: Record<string, unknown>
): CreatedContract[] {
  const out: CreatedContract[] = [];
  for (const node of Object.values(eventsById)) {
    if (!node || typeof node !== "object") continue;
    const event = node as {
      CreatedTreeEvent?: { value?: CreatedContract };
      CreatedEvent?: CreatedContract;
    };
    const created = event.CreatedTreeEvent?.value ?? event.CreatedEvent;
    if (created?.contractId) out.push(created);
  }
  return out;
}

function sameInstrument(
  actual: unknown,
  expected: InstrumentId
): boolean {
  if (!actual || typeof actual !== "object") return false;
  const value = actual as { admin?: unknown; id?: unknown };
  return value.admin === expected.admin && value.id === expected.id;
}

function sameAmount(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  try {
    return (
      toBaseUnitsFloor(actual, 8) === toBaseUnitsFloor(expected, 8)
    );
  } catch {
    return false;
  }
}

function sameInstant(actual: unknown, expected: Date): boolean {
  if (typeof actual !== "string") return false;
  const time = Date.parse(actual);
  return Number.isFinite(time) && time === expected.getTime();
}

export function recoverExactAllocationFromEvents(
  eventsById: Record<string, unknown>,
  expected: {
    settlementId: string;
    senderParty: string;
    receiverParty: string;
    executorParty: string;
    amountBtc: string;
    instrumentId: InstrumentId;
    settleBefore: Date;
  }
): { allocationCid: string } | null {
  for (const created of createdContracts(eventsById)) {
    if (!(created.templateId ?? "").includes("Allocation")) continue;
    const args = (created.createArgument ?? {}) as {
      settlement?: Record<string, unknown>;
      transferLeg?: Record<string, unknown>;
      allocation?: {
        settlement?: Record<string, unknown>;
        transferLeg?: Record<string, unknown>;
      };
    };
    const settlement = args.settlement ?? args.allocation?.settlement;
    const leg = args.transferLeg ?? args.allocation?.transferLeg;
    const settlementRef = settlement?.settlementRef as
      | { id?: unknown }
      | undefined;
    if (settlementRef?.id !== expected.settlementId) continue;
    if (
      settlement?.executor !== expected.executorParty ||
      settlement?.settleBefore == null ||
      !sameInstant(settlement.settleBefore, expected.settleBefore) ||
      leg?.sender !== expected.senderParty ||
      leg?.receiver !== expected.receiverParty ||
      !sameAmount(leg?.amount, expected.amountBtc) ||
      !sameInstrument(leg?.instrumentId, expected.instrumentId)
    ) {
      throw new Error("committed Allocation terms do not match the order");
    }
    return { allocationCid: created.contractId! };
  }
  return null;
}

export function recoverExactHtlcLockFromEvents(
  eventsById: Record<string, unknown>,
  expected: {
    lockerParty: string;
    receiverParty: string;
    executorParty: string;
    allocationCid: string;
    amountBtc: string;
    instrumentId: InstrumentId;
    hashLock: string;
    unlockTime: Date;
  }
): { htlcCid: string; htlcBlob: string } | null {
  const expectedHash = expected.hashLock.replace(/^0x/, "").toLowerCase();
  for (const created of createdContracts(eventsById)) {
    if (!(created.templateId ?? "").includes("HtlcLock")) continue;
    const args = (created.createArgument ?? {}) as Record<string, unknown>;
    const actualHash =
      typeof args.hashLock === "string"
        ? args.hashLock.replace(/^0x/, "").toLowerCase()
        : "";
    if (args.allocationCid !== expected.allocationCid) continue;
    if (
      args.locker !== expected.lockerParty ||
      args.receiver !== expected.receiverParty ||
      args.executor !== expected.executorParty ||
      !sameAmount(args.amount, expected.amountBtc) ||
      !sameInstrument(args.instrumentId, expected.instrumentId) ||
      actualHash !== expectedHash ||
      !sameInstant(args.unlockTime, expected.unlockTime)
    ) {
      throw new Error("committed HtlcLock terms do not match the order");
    }
    return {
      htlcCid: created.contractId!,
      htlcBlob: created.createdEventBlob ?? ""
    };
  }
  return null;
}
