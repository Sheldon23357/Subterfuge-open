type Fleet={state:string;departureCommitted?:boolean};
export function launchLocked(f:Fleet){
  return f.state==='waiting'&&f.departureCommitted;
}
export function preparingFleet(f:Fleet){
  return f.state==='waiting'&&!launchLocked(f);
}
