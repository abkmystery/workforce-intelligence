export interface Grant { domain:string; operation:string; dataClass:string; orgId:string|null; scope:'tenant'|'org'|'subtree'|'reports'; validFrom:string; validTo:string|null }
export interface Actor { tenantId:string; userId:string; sessionId:string; roles:string[]; grants:Grant[]; authVersion:number }
export interface RecordRow { id:string; tenantId:string; orgId:string|null; workerId:string|null; validFrom:string; validTo:string|null; version:number; state:string; data:Record<string,unknown> }
export interface FieldDefinition { label:string; type:'text'|'number'|'boolean'|'date'|'uuid'|'select'; required?:boolean; nullable?:boolean; options?:string[]; owner?:string; sensitive?:boolean }
export interface DomainDefinition { key:string; table:string; label:string; dataClass:string; fields:Record<string,FieldDefinition> }
export interface RecordFilter { date?:string; orgId?:string; search?:string; state?:string; roleId?:string; considerForRoles?:boolean; page?:number; pageSize?:number; sort?:string; direction?:string }
export interface MutationInput { operation:'CREATE'|'UPDATE'|'ARCHIVE'|'RESTORE'; id?:string; version?:number; orgId?:string|null; workerId?:string|null; validFrom?:string; validTo?:string|null; data?:Record<string,unknown> }
