import { useEffect, useState } from 'react';

interface Discrepancy {
  id: string;
  type: string;
  severity: string;
  status: string;
  description: string;
  systemA: string;
  systemB: string;
  valueA: string;
  valueB: string;
  delta: number;
  detectedAt: string;
  classification: string;
  confidence: number;
  overlapDays: number;
}

interface RunMeta {
  runId: string;
  timestamp: string;
  totalRecords: number;
  duplicatesFound: number;
  trueDuplicates: number;
  migrations: number;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/30',
  high: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  low: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
};

export function DiscrepancyTable() {
  const [discrepancies, setDiscrepancies] = useState<Discrepancy[]>([]);
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing discrepancies on mount
  useEffect(() => {
    setLoading(true);
    fetch('http://localhost:3001/api/reconciliation/discrepancies')
      .then(r => r.json())
      .then(d => { setDiscrepancies(d.data ?? []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  function runReconciliation() {
    setRunning(true);
    setError(null);
    fetch('http://localhost:3001/api/reconciliation/run', { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        setDiscrepancies(d.discrepancies ?? []);
        setMeta(d.meta ?? null);
        setRunning(false);
      })
      .catch(e => { setError(e.message); setRunning(false); });
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Discrepancies</h1>
        <button
          onClick={runReconciliation}
          disabled={running}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {running ? 'Running...' : 'Run Reconciliation'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-red-400 text-sm">
          {error}
        </div>
      )}

      {meta && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Records Scanned', value: meta.totalRecords.toLocaleString() },
            { label: 'Issues Found', value: meta.duplicatesFound },
            { label: 'True Duplicates', value: meta.trueDuplicates },
            { label: 'Migrations', value: meta.migrations },
          ].map(card => (
            <div key={card.label} className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
              <p className="text-xs text-slate-400 mb-1">{card.label}</p>
              <p className="text-xl font-bold text-white">{card.value}</p>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : discrepancies.length === 0 ? (
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-8 text-center">
          <p className="text-slate-400">No discrepancies found. Click "Run Reconciliation" to scan.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="px-4 py-3 text-slate-400 font-medium">Severity</th>
                <th className="px-4 py-3 text-slate-400 font-medium">Description</th>
                <th className="px-4 py-3 text-slate-400 font-medium">Stripe Value</th>
                <th className="px-4 py-3 text-slate-400 font-medium">Chargebee Value</th>
                <th className="px-4 py-3 text-slate-400 font-medium">Delta</th>
                <th className="px-4 py-3 text-slate-400 font-medium">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {discrepancies.map(d => (
                <tr key={d.id} className="hover:bg-slate-700/20 transition-colors">
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs border ${SEVERITY_COLORS[d.severity] ?? ''}`}>
                      {d.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-300 max-w-xs truncate">{d.description}</td>
                  <td className="px-4 py-3 text-slate-400">{d.valueA}</td>
                  <td className="px-4 py-3 text-slate-400">{d.valueB}</td>
                  <td className="px-4 py-3 text-slate-300">${d.delta.toFixed(2)}</td>
                  <td className="px-4 py-3 text-slate-400">{(d.confidence * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}