/** Narrow declaration for the Node >=22.13 built-in API used here; runtime is node:sqlite. */
declare module 'node:sqlite' {
 export class DatabaseSync {
  constructor(path:string,options?:{readOnly?:boolean});
  exec(sql:string):void;
  prepare(sql:string):{get(...parameters:(string|number|null)[]):Record<string,unknown>|undefined;all(...parameters:(string|number|null)[]):Record<string,unknown>[];run(...parameters:(string|number|null)[]):{changes:number|bigint;lastInsertRowid:number|bigint}};
  close():void;
 }
}
