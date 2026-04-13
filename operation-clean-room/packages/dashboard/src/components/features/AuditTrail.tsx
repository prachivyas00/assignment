import { useEffect, useState } from 'react';

interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  entity: string;
  entityId: string;
  description: string;
  source: string;
  recordCount: number;
  status: 'success' | 'warning' | 'error';
}

const STATUS_COLORS: Record<string, string> = {
  success: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  warning: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const ACTION_LABELS: Record<string, string> = {
  data_ingested: 'Data Ingested',
  metric_calculated: 'Metric Calculated',
  reconciliation_run: 'Reconciliation Run',
  assumption_logged: 'Assumption Logged',
};

export function AuditTrail() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('http://localhost:3001/api/metrics/audit')
      .then(r => r.json())
      .then(d => { setEntries(d.data ?? []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div className="p-6 text-slate-400">Loading audit trail...</div>;
  if (error) return <div className="p-6 text-red-400">Error: {error}</div>;

  const successCount = entries.filter(e => e.status === 'success').length;
  const warningCount = entries.filter(e => e.status === 'warning').length;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Audit Trail</h1>
        <p className="text-slate-400 text-sm mt-1">
          Every number on this dashboard is traceable to its source. This log documents all data ingestion, transformations, and assumptions made by the reconciliation engine.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Total Entries</p>
          <p className="text-xl font-bold text-white">{entries.length}</p>
        </div>
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="text-xs text-emerald-400 mb-1">Successful Operations</p>
          <p className="text-xl font-bold text-emerald-400">{successCount}</p>
        </div>
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
          <p className="text-xs text-yellow-400 mb-1">Assumptions Logged</p>
          <p className="text-xl font-bold text-yellow-400">{warningCount}</p>
        </div>
      </div>

      {/* Entries */}
      <div className="space-y-3">
        {entries.map(entry => (
          <div
            key={entry.id}
            className="rounded-lg border border-slate-700 bg-slate-800/50 p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs border ${STATUS_COLORS[entry.status]}`}>
                    {entry.status}
                  </span>
                  <span className="text-xs text-slate-500 bg-slate-700 px-2 py-0.5 rounded">
                    {ACTION_LABELS[entry.action] ?? entry.action}
                  </span>
                  <span className="text-xs text-slate-500">{entry.source}</span>
                </div>
                <p className="text-slate-200 text-sm">{entry.description}</p>
                {entry.recordCount > 0 && (
                  <p className="text-xs text-slate-500 mt-1">
                    {entry.recordCount.toLocaleString()} records processed
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-slate-500">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </p>
                <p className="text-xs text-slate-600 font-mono">{entry.id}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}