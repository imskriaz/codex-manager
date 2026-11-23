export type OfficeStateRow = { namespace: string; key: string; value: string };

/** Master namespaces and shared host configuration always stay on this PC. */
export function isOfficeState(namespace: string, key?: string): boolean {
  return namespace.startsWith('office-') && !namespace.split(':').slice(1).includes('master') && key !== 'master';
}

export function officeMigrationRows(rows: OfficeStateRow[]): OfficeStateRow[] {
  return rows.flatMap(row => {
    if (!isOfficeState(row.namespace, row.key)) return [];
    const value: unknown = JSON.parse(row.value);
    if (row.namespace === 'office-audit' && Array.isArray(value)) {
      return [{...row, value: JSON.stringify(value.filter((entry: {actor?: {id?: string}}) => entry.actor?.id !== 'master'))}];
    }
    if (row.namespace === 'office-session-actors' && (value as {startedBy?: {id?: string}})?.startedBy?.id === 'master') return [];
    return [row];
  });
}
