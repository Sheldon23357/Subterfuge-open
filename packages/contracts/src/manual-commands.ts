/** Server-authored command facts. Never model-inferred intent or confirmed prose directives. */
export interface ManualCommandReceipt {
 id:string;version:number;player:number;tick:number;seconds:number;
 kind:'order'|'schedule'|'cancel-schedule'|'release-protection';orderId?:string;scheduleId?:string;
 action?:{kind:string;[key:string]:unknown};outcome:'applied'|'scheduled'|'cancelled'|'released';
 /** Archived release facts are read-only compatibility data. No current API produces them. */
 operationId?:string;releasedReceiptIds?:string[];releasedScopes?:string[];
 affectedFleetIds:string[];cancelledScheduleIds:string[];
}
export interface ManualCommandProtection {
 receiptId:string;kind:'fleet'|'schedule'|'route'|'outpost'|'resources'|'funding';
 /** Explicit keys, e.g. fleet:F, source:A, destination:outpost:B. */
 scope:string[];expiresAtTick?:number;
}
export interface ManualCommandView {
 version:number;receipts:ManualCommandReceipt[];protections:ManualCommandProtection[];
 /** Older immutable facts remain available through the authenticated manual command collection. */
 receiptsFromVersion:number;hasEarlierReceipts:boolean;
}
