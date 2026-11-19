/** Decimal units for token usage; preserve the exact count in the UI tooltip. */
export function compactNumber(value:number):string {
  const units=['','K','M','B'];
  let unit=0;
  while(Math.abs(value)>=999.5&&unit<units.length-1){value/=1000;unit++;}
  return `${Number(value.toFixed(unit?1:0))}${units[unit]}`;
}
