import type { DatabaseSync } from 'node:sqlite';
const depths=new WeakMap<DatabaseSync,number>();let savepoint=0;
/** Synchronous nesting uses savepoints on the SAME connection, never another database. */
export function sqliteTransaction<T>(db:DatabaseSync,change:()=>T,mode:'read'|'write'='write'):T {
  const depth=depths.get(db)??0,name=`nested_${++savepoint}`;
  db.exec(depth?`SAVEPOINT ${name}`:mode==='read'?'BEGIN':'BEGIN IMMEDIATE');depths.set(db,depth+1);
  try {const result=change();if(result&&typeof (result as {then?:unknown}).then==='function')throw Error('SQLite transaction callbacks must be synchronous');db.exec(depth?`RELEASE SAVEPOINT ${name}`:'COMMIT');return result;}
  catch(error){try{db.exec(depth?`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`:'ROLLBACK');}catch{/* Preserve original failure; connection must not be reused after an SQLite failure. */}throw error;}
  finally{if(depth)depths.set(db,depth);else depths.delete(db);}
}
export function insideSqliteTransaction(db:DatabaseSync){return (depths.get(db)??0)>0;}
