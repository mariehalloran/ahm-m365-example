import { isInconclusiveCategory, reportedResult, resultSchema, type SyntheticResult, type Telemetry } from "../contracts.js";
import { providerLog, type ProviderDiagnostic } from "../providers/provider-diagnostics.js";

export type ExecutionMode = "simulation" | "live";
export type Outcome = "success" | "failure" | "unknown";
export interface CycleResults { cycleId: string; results: SyntheticResult[]; signal?: AbortSignal }
export type CyclePublisher = (cycle: CycleResults) => Promise<void>;
export interface ResultContext {
  tenant: string;
  user?: string;
  peer?: string;
  groups: { id: string; displayName: string }[];
}
export interface ResultOutput {
  record(result: SyntheticResult, mode: ExecutionMode): void;
  recordDiagnostic(record: ProviderDiagnostic): void;
}

/** Distinguishes observed service failures from worker/cleanup outcomes with no binary sample. */
export function outcomeOf(result: SyntheticResult): Outcome {
  if (isInconclusiveCategory(result.diagnosticCategory)) return "unknown";
  return result.success ? "success" : "failure";
}

/** Emits explicit no-sample console results, retaining target/group context when available. */
export function createResultOutput(
  output: Telemetry, contextOf?: (result: SyntheticResult) => ResultContext,
): ResultOutput {
  return {
    record(raw, mode) {
      const result = reportedResult(resultSchema.parse(raw));
      const outcome = outcomeOf(result);
      output.emit("synthetic-result", {
        mode, outcome, result: { ...result, success: outcome === "unknown" ? null : result.success },
        ...(contextOf ? { context: contextOf(result) } : {}),
      });
    },
    recordDiagnostic(record) {
      output.emit("provider-diagnostic", providerLog(record));
    },
  };
}
