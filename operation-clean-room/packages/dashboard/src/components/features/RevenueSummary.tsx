import { useEffect, useState } from 'react';

interface ARRBreakdown {
  label: string;
  arr: number;
  customerCount: number;
  percentOfTotal: number;
}

interface ARRData {
  total: number;
  asOfDate: string;
  totalCustomers: number;
  avgARRPerCustomer: number;
  medianARRPerCustomer: number;
  byPlan: ARRBreakdown[];
  byRegion: ARRBreakdown[];
  bySegment: ARRBreakdown[];
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function RevenueSummary() {
  const [data, setData] = useState<ARRData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:3001/api/metrics/arr')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return (
    <div className="p-6 text-slate-400">Loading revenue data...</div>
  );

  if (error) return (
    <div className="p-6 text-red-400">Error: {error}</div>
  );

  if (!data) return null;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-white">Revenue Summary</h1>

      {/* Top metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: 'Total ARR', value: fmt(data.total) },
          { label: 'Total Customers', value: data.totalCustomers.toLocaleString() },
          { label: 'Avg ARR / Customer', value: fmt(data.avgARRPerCustomer) },
          { label: 'Median ARR / Customer', value: fmt(data.medianARRPerCustomer) },
        ].map(card => (
          <div key={card.label} className="rounded-lg border border-slate-700 bg-slate-800/50 p-5">
            <p className="text-sm text-slate-400 mb-1">{card.label}</p>
            <p className="text-2xl font-bold text-white">{card.value}</p>
          </div>
        ))}
      </div>

      {/* ARR by Plan */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-5">
        <h2 className="text-lg font-semibold text-slate-200 mb-4">ARR by Plan</h2>
        <div className="space-y-3">
          {data.byPlan.map(row => (
            <div key={row.label}>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-slate-300">{row.label}</span>
                <span className="text-slate-300">{fmt(row.arr)} ({row.percentOfTotal}%)</span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full"
                  style={{ width: `${row.percentOfTotal}%` }}
                />
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{row.customerCount} customers</p>
            </div>
          ))}
        </div>
      </div>

      {/* ARR by Segment */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-5">
        <h2 className="text-lg font-semibold text-slate-200 mb-4">ARR by Segment</h2>
        <div className="space-y-3">
          {data.bySegment.map(row => (
            <div key={row.label}>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-slate-300">{row.label}</span>
                <span className="text-slate-300">{fmt(row.arr)} ({row.percentOfTotal}%)</span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-2">
                <div
                  className="bg-emerald-500 h-2 rounded-full"
                  style={{ width: `${row.percentOfTotal}%` }}
                />
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{row.customerCount} customers</p>
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-slate-600">As of {data.asOfDate} · Source: Chargebee</p>
    </div>
  );
}