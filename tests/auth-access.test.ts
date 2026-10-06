import {beforeEach,describe,it,expect,vi} from 'vitest';
import type { Actor } from '../src/lib/types';
import type { DbClient } from '../src/lib/db';
const mocks=vi.hoisted(()=>({permission:vi.fn(),audit:vi.fn()}));
vi.mock('../src/lib/policy',()=>({assertPermission:mocks.permission}));
vi.mock('../src/lib/audit',()=>({audit:mocks.audit}));
import {approveSensitiveAccess} from '../src/lib/graph/admin-access';
const actor:Actor={tenantId:'10000000-0000-0000-0000-000000000000',userId:'20000000-0000-0000-0000-000000000000',sessionId:'test',roles:[],grants:[],authVersion:1};
const requester='30000000-0000-0000-0000-000000000000';const target='40000000-0000-0000-0000-000000000000';const group='50000000-0000-0000-0000-000000000000';
const access={domain:'identities',operation:'READ',dataClass:'identity',orgId:null,scope:'tenant',principalId:target,validFrom:'2026-01-01',validTo:null};
function database(request:Record<string,unknown>,fresh=true,member=false){const query=vi.fn(async(sql:string)=>{
 if(sql.includes('FROM sensitive_access_requests'))return {rows:[request],rowCount:1};
 if(sql.includes('FROM graph_group_memberships'))return {rows:[],rowCount:member?1:0};
 if(sql.includes('FROM sync_checkpoints'))return {rows:[],rowCount:fresh?1:0};
 return {rows:[],rowCount:0};
});return {query,tx:{query} as unknown as DbClient};}
beforeEach(()=>vi.clearAllMocks());
describe('independent sensitive access approval',()=>{
 it('prevents the requester approving their own access change',async()=>{const db=database({state:'pending',requested_by:actor.userId,kind:'grants',payload:access});await expect(approveSensitiveAccess(db.tx,actor,target)).rejects.toMatchObject({code:'INDEPENDENT_APPROVER_REQUIRED'});expect(db.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO access_grants'))).toBe(false);});
 it('prevents the target principal approving their own grant',async()=>{const db=database({state:'pending',requested_by:requester,kind:'grants',payload:{...access,principalId:actor.userId}});await expect(approveSensitiveAccess(db.tx,actor,target)).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});});
 it('requires a current snapshot for this particular group before approving its mapping',async()=>{const db=database({state:'pending',requested_by:requester,kind:'mappings',payload:{...access,principalId:undefined,groupId:group}},false);await expect(approveSensitiveAccess(db.tx,actor,target)).rejects.toMatchObject({code:'ENTITLEMENTS_REFRESH_REQUIRED'});expect(db.query).toHaveBeenCalledWith(expect.stringContaining('full_scan=false'),[actor.tenantId,`group:${group}`]);});
 it('prevents an existing group member approving that group mapping',async()=>{const db=database({state:'pending',requested_by:requester,kind:'mappings',payload:{...access,principalId:undefined,groupId:group}},true,true);await expect(approveSensitiveAccess(db.tx,actor,target)).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});});
 it('requires domain-specific administration and records independent approval',async()=>{const db=database({state:'pending',requested_by:requester,kind:'grants',payload:access});await approveSensitiveAccess(db.tx,actor,target);expect(mocks.permission).toHaveBeenCalledWith(actor,'identities','ADMIN',null,'identity',db.tx);expect(db.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO access_grants'))).toBe(true);expect(mocks.audit).toHaveBeenCalledWith(db.tx,actor,'APPROVE_ACCESS','settings',target);});
});
