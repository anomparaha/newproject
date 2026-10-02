/**
 * Reputasi dihitung dari event, bukan dari input manual.
 *
 * Ranking pasar inspeksi TIDAK DIJUAL: urutan tampil berasal dari tingkat laporan
 * tepat waktu, tingkat sengketa, dan kelengkapan standar. Bengkel dengan sengketa
 * berulang keluar dari daftar.
 */

import type { DatabaseSync } from 'node:sqlite';
import { all, get, json, nowIso, run } from './db.js';

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface ReputationResult {
  actorId: string;
  role: string;
  dealsCompleted: number;
  disputesOpened: number;
  disputesLost: number;
  onTimeReportRate: number | null;
  standardComplianceRate: number | null;
  medianReportHours: number | null;
  listedInRanking: boolean;
}

export function recomputeReputation(db: DatabaseSync, actorId: string): ReputationResult | null {
  const actor = get(db, 'SELECT * FROM actors WHERE id = ?', [actorId]);
  if (!actor) return null;
  const role = String(actor.role);

  const deals = all(
    db,
    `SELECT * FROM deals WHERE buyer_id = ? OR seller_id = ? OR inspector_id = ?`,
    [actorId, actorId, actorId],
  );
  const dealIds = deals.map((d) => String(d.id));
  const dealsCompleted = deals.filter((d) => String(d.state) === 'completed').length;

  const disputes =
    dealIds.length > 0
      ? all(db, `SELECT * FROM disputes WHERE deal_id IN (${dealIds.map(() => '?').join(',')})`, dealIds)
      : [];
  const disputesOpened = disputes.length;
  const disputesLost = disputes.filter((d) => {
    const outcome = d.outcome === null ? null : String(d.outcome);
    if (role === 'inspector') return outcome === 'refund_buyer';
    return outcome === 'refund_buyer' || outcome === 'bond_slashed';
  }).length;

  let onTimeReportRate: number | null = null;
  let standardComplianceRate: number | null = null;
  let medianReportHours: number | null = null;

  if (role === 'inspector') {
    const reports = all(db, 'SELECT * FROM inspection_reports WHERE inspector_id = ?', [actorId]);
    const durations: number[] = [];
    let onTime = 0;
    let compliant = 0;
    for (const report of reports) {
      const deal = deals.find((d) => String(d.id) === String(report.deal_id));
      if (deal) {
        const deadline = Date.parse(String(deal.inspection_deadline));
        const uploaded = Date.parse(String(report.created_at));
        if (uploaded <= deadline) onTime += 1;
        const committed = get(
          db,
          `SELECT created_at FROM events WHERE deal_id = ? AND type = 'deal_committed' ORDER BY seq ASC LIMIT 1`,
          [String(report.deal_id)],
        );
        if (committed) {
          durations.push((uploaded - Date.parse(String(committed.created_at))) / 3_600_000);
        }
      }
      const checklist = json<Record<string, boolean>>(report.checklist as string, {});
      const required = ['vin_matches_unit', 'dashboard_photo', 'odometer_documented', 'main_condition', 'date_and_location'];
      if (required.every((k) => checklist[k] === true)) compliant += 1;
    }
    onTimeReportRate = reports.length > 0 ? Number((onTime / reports.length).toFixed(4)) : null;
    standardComplianceRate = reports.length > 0 ? Number((compliant / reports.length).toFixed(4)) : null;
    medianReportHours = median(durations) === null ? null : Number(median(durations)!.toFixed(2));
  }

  const listedInRanking = disputesLost < 2;
  const lastComputedAt = nowIso();
  run(
    db,
    `INSERT INTO reputation (actor_id, role, deals_completed, disputes_opened, disputes_lost, on_time_report_rate,
      standard_compliance_rate, median_report_hours, listed_in_ranking, last_computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(actor_id) DO UPDATE SET
       role = excluded.role,
       deals_completed = excluded.deals_completed,
       disputes_opened = excluded.disputes_opened,
       disputes_lost = excluded.disputes_lost,
       on_time_report_rate = excluded.on_time_report_rate,
       standard_compliance_rate = excluded.standard_compliance_rate,
       median_report_hours = excluded.median_report_hours,
       listed_in_ranking = excluded.listed_in_ranking,
       last_computed_at = excluded.last_computed_at`,
    [
      actorId,
      role,
      dealsCompleted,
      disputesOpened,
      disputesLost,
      onTimeReportRate,
      standardComplianceRate,
      medianReportHours,
      listedInRanking ? 1 : 0,
      lastComputedAt,
    ],
  );

  return {
    actorId,
    role,
    dealsCompleted,
    disputesOpened,
    disputesLost,
    onTimeReportRate,
    standardComplianceRate,
    medianReportHours,
    listedInRanking,
  };
}

export function recomputeAll(db: DatabaseSync): ReputationResult[] {
  const actors = all(db, 'SELECT id FROM actors');
  return actors.map((a) => recomputeReputation(db, String(a.id))).filter((r): r is ReputationResult => r !== null);
}
