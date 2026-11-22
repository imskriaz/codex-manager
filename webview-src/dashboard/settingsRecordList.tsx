import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ModalShell } from "./primitives";

export type SettingsRecord = { id: string; label: string; cells: ComponentChildren[]; details: ComponentChildren | ((close: () => void) => ComponentChildren) };

export function SettingsRecordList(props: { label: string; columns: string[]; rows: SettingsRecord[]; open?: boolean; onOpen?: () => void; onSelect?: (id: string) => void }) {
  const [selected, setSelected] = useState<SettingsRecord>();
  useEffect(() => { if (props.open === false) setSelected(undefined); }, [props.open]);
  const open = (row: SettingsRecord) => { if (props.onSelect) { props.onSelect(row.id); return; } setSelected(row); props.onOpen?.(); };
  return <>
    <div class="settings-record-scroll"><table class="settings-record-table" aria-label={props.label}>
      <thead><tr>{props.columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
      <tbody>{props.rows.map(row => <tr key={row.id} onClick={() => open(row)}>{row.cells.map((cell, index) => <td key={index}>{index === 0 ? <button type="button" class="settings-record-open" aria-label={row.label} onClick={event => { event.stopPropagation(); open(row); }}>{cell}</button> : cell}</td>)}</tr>)}</tbody>
    </table></div>
    <ModalShell open={Boolean(selected) && props.open !== false} title={selected?.label ?? "Record details"} closeLabel="Close record details" className="settings-record-modal" onClose={() => setSelected(undefined)}>{typeof selected?.details === "function" ? selected.details(() => setSelected(undefined)) : selected?.details}</ModalShell>
  </>;
}

export function SettingsRecordDetails(props: { fields: Array<[string, ComponentChildren]> }) {
  return <dl class="settings-record-details">{props.fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>;
}
