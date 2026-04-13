import { useEffect, useState } from 'react';

interface HealthSignals {
  usage: number;
  support: number;
  payment: number;
  engagement: number;
  nps: number | null;
}

interface Customer {
  customerId: string;
  name: string;
  healthScore: number;
  grade: string;
  signals: HealthSignals;
  arr: number;
  plan: string;
  churnRisk: number;
  status: string;
}

const GRADE_COLORS: Record<string, string> = {
  A: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  B: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  C: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  D: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  F: 'bg-red-500/20 text-red-400 border-red-500/30',
};

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-full bg-slate-700 rounded-full h-1.5">
      <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${value}%` }} />
    </div>
  );
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function CustomerHealth() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('http://localhost:3001/api/metrics/customer-health')
      .then(r => r.json())
      .then(d => { setCustomers(d.data ?? []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div className="p-6 text-slate-400">Loading customer health data...</div>;
  if (error) return <div className="p-6 text-red-400">Error: {error}</div>;

  const filtered = customers
    .filter(c => filter === 'all' || c.grade === filter)
    .filter(c => search === '' || c.name.toLowerCase().includes(search.toLowerCase()));

  const gradeCounts = ['A', 'B', 'C', 'D', 'F'].map(g => ({
    grade: g,
    count: customers.filter(c => c.grade === g).length,
  }));

  const atRisk = customers.filter(c => c.churnRisk > 60).length;
  const totalARR = customers.reduce((sum, c) => sum + c.arr, 0);
  const atRiskARR = customers.filter(c => c.churnRisk > 60).reduce((sum, c) => sum + c.arr, 0);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-white">Customer Health</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Total Customers</p>
          <p className="text-xl font-bold text-white">{customers.length}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">At Risk (Churn &gt; 60%)</p>
          <p className="text-xl font-bold text-red-400">{atRisk}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">At-Risk ARR</p>
          <p className="text-xl font-bold text-orange-400">{fmt(atRiskARR)}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Total ARR Tracked</p>
          <p className="text-xl font-bold text-white">{fmt(totalARR)}</p>
        </div>
      </div>

      {/* Grade distribution */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Health Grade Distribution</h2>
        <div className="flex gap-3">
          {gradeCounts.map(({ grade, count }) => (
            <button
              key={grade}
              onClick={() => setFilter(filter === grade ? 'all' : grade)}
              className={`flex-1 rounded-lg border p-3 text-center transition-colors cursor-pointer
                ${filter === grade ? GRADE_COLORS[grade] : 'border-slate-700 bg-slate-800 hover:bg-slate-700'}`}
            >
              <p className="text-lg font-bold text-white">{grade}</p>
              <p className="text-xs text-slate-400">{count} customers</p>
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search customers..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
      />

      {/* Table */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-left">
              <th className="px-4 py-3 text-slate-400 font-medium">Customer</th>
              <th className="px-4 py-3 text-slate-400 font-medium">Grade</th>
              <th className="px-4 py-3 text-slate-400 font-medium">Health Score</th>
              <th className="px-4 py-3 text-slate-400 font-medium">Plan</th>
              <th className="px-4 py-3 text-slate-400 font-medium">ARR</th>
              <th className="px-4 py-3 text-slate-400 font-medium">Churn Risk</th>
              <th className="px-4 py-3 text-slate-400 font-medium w-32">Signals</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {filtered.slice(0, 100).map(c => (
              <tr key={c.customerId} className="hover:bg-slate-700/20 transition-colors">
                <td className="px-4 py-3 text-slate-200 font-medium max-w-xs truncate">{c.name}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs border font-bold ${GRADE_COLORS[c.grade] ?? ''}`}>
                    {c.grade}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-300 w-8">{c.healthScore}</span>
                    <div className="w-20">
                      <ScoreBar
                        value={c.healthScore}
                        color={c.healthScore >= 70 ? 'bg-emerald-500' : c.healthScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-400">{c.plan}</td>
                <td className="px-4 py-3 text-slate-300">{fmt(c.arr)}</td>
                <td className="px-4 py-3">
                  <span className={`text-sm font-medium ${c.churnRisk > 60 ? 'text-red-400' : c.churnRisk > 40 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                    {c.churnRisk}%
                  </span>
                </td>
                <td className="px-4 py-3 space-y-1">
                  <ScoreBar value={c.signals.usage} color="bg-blue-500" />
                  <ScoreBar value={c.signals.payment} color="bg-emerald-500" />
                  <ScoreBar value={c.signals.engagement} color="bg-purple-500" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 100 && (
          <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-700">
            Showing 100 of {filtered.length} customers
          </p>
        )}
      </div>
    </div>
  );
}