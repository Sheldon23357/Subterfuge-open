import type {ChatStore} from './chat.js';
/** Used exclusively by the local admin listener; never by player routes. */
export function observerChatPage(chat:ChatStore,roomId:string,query:URLSearchParams) {
  const values:{before?:number;after?:number;limit?:number}={};
  for(const key of query.keys()) {
    if(!['before','after','limit'].includes(key)||query.getAll(key).length!==1||!/^(0|[1-9][0-9]*)$/.test(query.get(key)!))throw Error('无效聊天分页参数');
    values[key as keyof typeof values]=Number(query.get(key));
  }
  return {roomId,...chat.observerPage(values)};
}
