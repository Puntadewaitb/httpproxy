import type { Scope, ScopeRule } from './types.js';

export interface ScopeTarget {
  method: string;
  /** URL absolut. */
  url: string;
}

function ruleMatches(rule: ScopeRule, t: ScopeTarget, u: URL | null): boolean {
  if (rule.methods?.length && !rule.methods.some((m) => m.toUpperCase() === t.method.toUpperCase())) return false;
  if (rule.protocols?.length) {
    const proto = (u?.protocol ?? '').replace(':', '');
    if (!rule.protocols.includes(proto)) return false;
  }
  if (rule.host && !new RegExp(rule.host, 'i').test(u?.hostname ?? '')) return false;
  if (rule.path && !new RegExp(rule.path).test(u ? u.pathname + u.search : t.url)) return false;
  return true;
}

/** Cek apakah target masuk scope. Exclude selalu menang; include kosong = semua. */
export function inScope(scope: Scope, t: ScopeTarget): boolean {
  let u: URL | null = null;
  try {
    u = new URL(t.url);
  } catch {
    /* URL tidak valid: cocokkan lewat string saja */
  }
  if (scope.exclude.some((r) => ruleMatches(r, t, u))) return false;
  if (scope.include.length === 0) return true;
  return scope.include.some((r) => ruleMatches(r, t, u));
}

export const emptyScope = (): Scope => ({ include: [], exclude: [] });
