import { db } from '../db/database';
import type { GeminiPlannedAction } from './geminiCoWorkerService';

export type GeminiExecutionMode = 'auto' | 'review' | 'force';
export type GeminiRiskLevel = 'low' | 'medium' | 'high';
export type GeminiExecutionStatus = 'running' | 'completed' | 'failed' | 'clarification' | 'review';

export type GeminiActionStatus = 'ok' | 'skipped' | 'error';

export interface GeminiExecutionActionRecord {
  actionIndex: number;
  actionType: string;
  status: GeminiActionStatus;
  resourceId?: string | null;
  summary?: string | null;
  errorMessage?: string | null;
  payload?: unknown;
}

export interface PersistGeminiExecutionInput {
  executionId: string;
  tripId: number;
  userId: number;
  sourceMessageId?: number | null;
  instruction?: string | null;
  model?: string | null;
  executionMode: GeminiExecutionMode;
  riskLevel: GeminiRiskLevel;
  approvalRequired: boolean;
  needsClarification: boolean;
  status: GeminiExecutionStatus;
  actionCount: number;
  successCount: number;
  skippedCount: number;
  errorCount: number;
  durationMs?: number | null;
  warnings?: string[] | null;
  errorMessage?: string | null;
  actionRecords?: GeminiExecutionActionRecord[];
}

const HIGH_RISK_ACTION_TYPES = new Set<GeminiPlannedAction['type']>([
  'create_place',
  'create_budget_item',
]);

const MEDIUM_RISK_ACTION_TYPES = new Set<GeminiPlannedAction['type']>([
  'create_packing_item',
  'create_todo',
]);

export function normalizeGeminiExecutionMode(value: unknown): GeminiExecutionMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'review') return 'review';
  if (raw === 'force') return 'force';
  return 'auto';
}

export function normalizeGeminiActionStatus(value: unknown): GeminiActionStatus {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'error') return 'error';
  if (raw === 'skipped') return 'skipped';
  return 'ok';
}

export function classifyGeminiRisk(actions: GeminiPlannedAction[]): GeminiRiskLevel {
  if (!Array.isArray(actions) || actions.length === 0) return 'low';

  let hasMediumRiskAction = false;
  for (const action of actions) {
    if (HIGH_RISK_ACTION_TYPES.has(action.type)) return 'high';
    if (MEDIUM_RISK_ACTION_TYPES.has(action.type)) hasMediumRiskAction = true;
  }

  if (actions.length >= 6) return 'high';
  if (hasMediumRiskAction || actions.length >= 3) return 'medium';
  return 'low';
}

export function persistGeminiExecution(input: PersistGeminiExecutionInput): void {
  try {
    const warningsJson = input.warnings && input.warnings.length > 0
      ? JSON.stringify(input.warnings)
      : null;

    const durationMs = Number.isFinite(input.durationMs as number)
      ? Math.max(0, Math.trunc(input.durationMs as number))
      : null;

    const actionRecords = Array.isArray(input.actionRecords) ? input.actionRecords : null;

    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO gemini_executions (
          id,
          trip_id,
          user_id,
          source_message_id,
          instruction,
          model,
          execution_mode,
          risk_level,
          approval_required,
          needs_clarification,
          status,
          action_count,
          success_count,
          skipped_count,
          error_count,
          duration_ms,
          warnings,
          error_message,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          model = excluded.model,
          execution_mode = excluded.execution_mode,
          risk_level = excluded.risk_level,
          approval_required = excluded.approval_required,
          needs_clarification = excluded.needs_clarification,
          status = excluded.status,
          action_count = excluded.action_count,
          success_count = excluded.success_count,
          skipped_count = excluded.skipped_count,
          error_count = excluded.error_count,
          duration_ms = excluded.duration_ms,
          warnings = excluded.warnings,
          error_message = excluded.error_message,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        input.executionId,
        input.tripId,
        input.userId,
        input.sourceMessageId ?? null,
        input.instruction ?? null,
        input.model ?? null,
        input.executionMode,
        input.riskLevel,
        input.approvalRequired ? 1 : 0,
        input.needsClarification ? 1 : 0,
        input.status,
        input.actionCount,
        input.successCount,
        input.skippedCount,
        input.errorCount,
        durationMs,
        warningsJson,
        input.errorMessage ?? null,
      );

      if (actionRecords) {
        db.prepare('DELETE FROM gemini_execution_actions WHERE execution_id = ?').run(input.executionId);

        const insertAction = db.prepare(`
          INSERT INTO gemini_execution_actions (
            execution_id,
            action_index,
            action_type,
            status,
            resource_id,
            summary,
            error_message,
            payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const action of actionRecords) {
          let payloadJson: string | null = null;
          if (action.payload !== undefined) {
            try {
              payloadJson = JSON.stringify(action.payload);
            } catch {
              payloadJson = null;
            }
          }

          insertAction.run(
            input.executionId,
            action.actionIndex,
            action.actionType,
            action.status,
            action.resourceId ?? null,
            action.summary ?? null,
            action.errorMessage ?? null,
            payloadJson,
          );
        }
      }
    });

    transaction();
  } catch {
    // Best effort persistence; never break main Gemini execution flow.
  }
}
