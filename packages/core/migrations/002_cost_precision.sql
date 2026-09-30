-- Per-run AI cost for cheap models is often < $0.0001; keep 6 decimals so totals don't round to zero.
ALTER TABLE agent_runs ALTER COLUMN cost_usd TYPE numeric(14,6);
