export function shortCommit(commit: string | null | undefined): string {
  if (!commit) return '—';
  return commit.slice(0, 8);
}

export function formatCost(costUsd: number | null | undefined): string {
  if (costUsd === null || costUsd === undefined) return '—';
  if (costUsd === 0) return '$0.00';
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return '—';
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return '—';
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '—';
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (Number.isNaN(end)) return '—';
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '—';
  return new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function statusTone(status: string): 'neutral' | 'success' | 'danger' | 'warning' | 'info' {
  switch (status) {
    case 'ok':
      return 'success';
    case 'error':
      return 'danger';
    case 'cancelled':
      return 'warning';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}
