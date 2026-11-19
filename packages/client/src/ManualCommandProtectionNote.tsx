import React from 'react';
import type {ManualCommandView} from '../../contracts/src/index.js';
export function ManualCommandProtectionNote({view,scopes}:{view:ManualCommandView|undefined;scopes:string[]}) {
  if(!view?.protections.some(row=>row.scope.some(scope=>scopes.includes(scope))))return null;
  return <small className="manual-command-protected" title="这是已生效的手动安排保护，不代表 AI 已完成战略复核。">手动安排优先 · AI 不会直接覆盖</small>;
}
