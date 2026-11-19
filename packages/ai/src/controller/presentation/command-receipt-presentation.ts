type Row=Record<string,unknown>;
const row=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Called only for a validated successful command observation. The complete
 * source is kept in the journal; current map and schedules have their own block. */
export function commandObservationReceipt(observation:Row):Row{
 const {view,scheduled,intel,outpostNames,historyStartTick,realtime,manualCommands,...receipt}=observation;
 return {...receipt,...(row(manualCommands)?{manualCommandVersion:manualCommands.version}:{}),accepted:true};
}
