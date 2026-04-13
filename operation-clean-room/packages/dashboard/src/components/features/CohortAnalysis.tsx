import { useEffect, useState } from 'react';

interface CohortRow {
  label: string;
  arr: number;
  customerCount: number;
  percentOfTotal: number;
}

interface ARRData {
  total: number;
  totalCustomers: number;
  byCohort: CohortRow[];
  byPlan: CohortRow[];
  byRegion: CohortRow[];
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

type Tab = 'cohort' | 'plan' | 'region';

export function CohortAnalysis() {
  const [data, setData] = useState<ARRData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('cohort');
  const [sortBy, setSortBy] = useState<'arr' | 'customers'>('arr');

  useEffect(() => {
    fetch('http://localhost:3001/api/metrics/arr')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div className="p-6 text-slate-400">Loading cohort data...</div>;
  if (error) return <div className="p-6 text-red-400">Error: {error}</div>;
  if (!data) return null;

  const rows = tab === 'cohort'
    ? [...data.byCohort].sort((a, b) =>
        sortBy === 'arr' ? b.arr - a.arr : b.customerCount - a.customerCount)
    : tab === 'plan'
    ? [...data.byPlan].sort((a, b) =>
        sortBy === 'arr' ? b.arr - a.arr : b.customerCount - a.customerCount)
    : [...data.byRegion].sort((a, b) =>
        sortBy === 'arr' ? b.arr - a.arr : b.customerCount - a.customerCount);

  const maxARR = Math.max(...rows.map(r => r.arr));

  const tabs: { key: Tab; label: string }[] = [
    { key: 'cohort', label: 'By Signup Month' },
    { key: 'plan', label: 'By Plan' },
    { key: 'region', label: 'By Region' },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Cohort Analysis</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setSortBy('arr')}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              sortBy === 'arr'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            Sort by ARR
          </button>
          <button
            onClick={() => setSortBy('customers')}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              sortBy === 'customers'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            Sort by Customers
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Total ARR</p>
          <p className="text-xl font-bold text-white">{fmt(data.total)}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Total Customers</p>
          <p className="text-xl font-bold text-white">{data.totalCustomers.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Cohorts Tracked</p>
          <p className="text-xl font-bold text-white">{data.byCohort.length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-left">
              <th className="px-4 py-3 text-slate-400 font-medium">
                {tab === 'cohort' ? 'Signup Month' : tab === 'plan' ? 'Plan' : 'Region'}
              </th>
              <th className="px-4 py-3 text-slate-400 font-medium">ARR</th>
              <th className="px-4 py-3 text-slate-400 font-medium">Customers</th>
              <th className="px-4 py-3 text-slate-400 font-medium">% of Total</th>
              <th className="px-4 py-3 text-slate-400 font-medium w-48">Distribution</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {rows.map(row => (
              <tr key={row.label} className="hover:bg-slate-700/20 transition-colors">
                <td className="px-4 py-3 text-slate-200 font-medium">
                  {row.label || 'Unknown'}
                </td>
                <td className="px-4 py-3 text-slate-300">{fmt(row.arr)}</td>
                <td className="px-4 py-3 text-slate-300">{row.customerCount}</td>
                <td className="px-4 py-3 text-slate-400">{row.percentOfTotal}%</td>
                <td className="px-4 py-3">
                  <div className="w-full bg-slate-700 rounded-full h-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full"
                      style={{ width: `${(row.arr / maxARR) * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}