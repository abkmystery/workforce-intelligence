import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeDatabase, transaction } from '../../src/lib/db';
import { mutateRecord, getRecord, listRecords } from '../../src/lib/records';
import { domains } from '../../src/lib/registry';
import { performAction } from '../../src/lib/workflows';
import { proposeTransfer } from '../../src/lib/transfers';
import { createTeamNeed } from '../../src/lib/team-needs';
import type { Actor, RecordRow } from '../../src/lib/types';

const tenantId = randomUUID();
const actors: Actor[] = Array.from({length: 5}, () => ({tenantId, userId: randomUUID(), sessionId: 'synthetic', roles: [], authVersion: 1, grants: Object.values(domains).map(d => ({domain: d.key, operation: '*', dataClass: d.dataClass, orgId: null, scope: 'tenant', validFrom: '2000-01-01', validTo: null}))}));
const owner = actors[0], date = '2026-11-01';
let sourceOrg: string, destinationOrg: string, roleId: string, oldRoleId: string, calendarId: string, skillId: string, oldManager: string, newManager: string;
async function approve(row: RecordRow, domain: string) {
  row = await performAction(owner, {action: 'submit', domain, id: row.id, version: row.version}) as RecordRow;
  const stages = domain === 'movements' ? ['source-manager','destination-manager','HR','Finance'] : ['manager','HR'];
  for (const [index, stage] of stages.entries()) row = await performAction(actors[index + 1], {action: 'approve', domain, id: row.id, version: row.version, stage}) as RecordRow;
  return row;
}
async function fixture(endedSource = false, eligibleFte = 1, needUntil: string | null = null, workerUntil: string | null = null) {
  const worker = await mutateRecord(owner, 'workers', {operation:'CREATE', orgId: sourceOrg, validFrom:'2026-01-01', validTo:workerUntil, data:{code: 'SYN-'+randomUUID(), workerType:'manual-only', employmentStatus:'active', homeOrgId:sourceOrg}});
  const assignment = await mutateRecord(owner,'assignments',{operation:'CREATE',orgId:sourceOrg,workerId:worker.id,validFrom:'2026-01-01',validTo:endedSource?date:null,data:{roleId:oldRoleId,fte:1,kind:'primary',allocationStatus:'committed'}});
  await mutateRecord(owner,'contracts',{operation:'CREATE',orgId:sourceOrg,workerId:worker.id,validFrom:'2026-01-01',data:{fte:eligibleFte,weeklyHours:40 * eligibleFte,calendarId,movable:true,confirmedOn:'2026-10-01'}});
  await mutateRecord(owner,'reporting-lines',{operation:'CREATE',orgId:sourceOrg,workerId:worker.id,validFrom:'2026-01-01',data:{managerId:oldManager,kind:'primary'}});
  const identity = await mutateRecord(owner,'identities',{operation:'CREATE',orgId:sourceOrg,workerId:worker.id,validFrom:'2026-01-01',data:{displayName:'SYNTHETIC protected identity'}});
  const pay = await mutateRecord(owner,'compensation',{operation:'CREATE',orgId:sourceOrg,workerId:worker.id,validFrom:'2026-01-01',data:{amount:90000,currency:'USD',basis:'annual',burdenPercent:20,paidFte:1,source:'Synthetic payroll'}});
  await mutateRecord(owner,'worker-skills',{operation:'CREATE',orgId:sourceOrg,workerId:worker.id,validFrom:'2026-01-01',data:{skillId,level:'proficient',verified:true}});
  const placement = await mutateRecord(owner,'redeployments',{operation:'CREATE',orgId:sourceOrg,workerId:worker.id,validFrom:'2026-10-01',data:{reason:'Project ending',considerForRoles:true,availableFrom:date,location:'Chicago',workMode:'hybrid',relocationPossible:false,fte:eligibleFte}});
  const need = await approve(await createTeamNeed(owner,{record:{operation:'CREATE',orgId:destinationOrg,validFrom:'2026-10-01',validTo:needUntil,data:{code:'NEED-'+randomUUID(),roleId,requestType:'transfer',fte:eligibleFte,headcount:1,priority:'normal',businessCase:'Retain internal expertise',fundingStatus:'funded',expectedStart:date}},skillIds:[skillId]}),'demands');
  const proposal = await approve(await proposeTransfer(owner,{placementId:placement.id,demandId:need.id,destinationManagerId:newManager,effectiveFrom:date,reason:'Both teams reviewed the retention placement'}),'movements');
  return {worker, assignment, identity, pay, placement, need, proposal};
}
const commit = (proposal: RecordRow, actor = owner) => performAction(actor,{action:'commit',domain:'movements',id:proposal.id,version:proposal.version});

describe.skipIf(!process.env.TEST_DATABASE_URL)('permanent internal retention transfers', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await transaction(tenantId, async tx => {
      await tx.query('INSERT INTO tenants(id,name,settings) VALUES($1,$2,$3)',[tenantId,'Synthetic retention transfers',{synthetic:true}]);
      for (const actor of actors) await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[actor.userId,tenantId,randomUUID()]);
    });
    sourceOrg=(await mutateRecord(owner,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'SOURCE',name:'Synthetic source',orgType:'Team'}})).id;
    destinationOrg=(await mutateRecord(owner,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'DEST',name:'Synthetic destination',orgType:'Team'}})).id;
    oldRoleId=(await mutateRecord(owner,'roles',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'Old role'}})).id;
    roleId=(await mutateRecord(owner,'roles',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'New role'}})).id;
    skillId=(await mutateRecord(owner,'skills',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'SQL'}})).id;
    calendarId=(await mutateRecord(owner,'calendars',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'Weekdays',weekdays:'1,2,3,4,5',hoursPerDay:8}})).id;
    oldManager=(await mutateRecord(owner,'workers',{operation:'CREATE',orgId:sourceOrg,validFrom:'2026-01-01',data:{code:'SYN-OLD-MANAGER',workerType:'manual-only',employmentStatus:'active',homeOrgId:sourceOrg}})).id;
    newManager=(await mutateRecord(owner,'workers',{operation:'CREATE',orgId:destinationOrg,validFrom:'2026-01-01',data:{code:'SYN-NEW-MANAGER',workerType:'manual-only',employmentStatus:'active',homeOrgId:destinationOrg}})).id;
  });
  afterAll(closeDatabase);
  it('commits after independent approvals, preserving dated history and separate pay/identity', async () => {
    const f = await fixture();
    const result = await commit(f.proposal) as {record:RecordRow;impact:{enterprisePayrollSavings:string}};
    expect(result.record.state).toBe('committed'); expect(result.impact.enterprisePayrollSavings).toBe('0.00');
    expect((await getRecord(owner,'workers',f.worker.id,'2026-10-31')).orgId).toBe(sourceOrg);
    const moved = await getRecord(owner,'workers',f.worker.id,date);
    expect(moved.orgId).toBe(destinationOrg); expect(moved.data.homeOrgId).toBe(destinationOrg); expect(moved.data.employmentStatus).toBe('active');
    for (const [domain, record] of [['identities',f.identity],['compensation',f.pay]] as const) {
      expect((await getRecord(owner,domain,record.id,'2026-10-31')).orgId).toBe(sourceOrg);
      const after=await getRecord(owner,domain,record.id,date); expect(after.orgId).toBe(destinationOrg); expect(after.data).toEqual(record.data);
    }
    const allocations=(await listRecords(owner,'assignments',{date:'2027-01-01',pageSize:200})).rows.filter(row=>row.workerId===f.worker.id);
    expect(allocations).toHaveLength(1); expect(allocations[0].orgId).toBe(destinationOrg); expect(allocations[0].data.roleId).toBe(roleId); expect(allocations[0].validTo).toBeNull();
    const lines=(await listRecords(owner,'reporting-lines',{date,pageSize:200})).rows.filter(row=>row.workerId===f.worker.id);
    expect(lines).toHaveLength(1); expect(lines[0].data.managerId).toBe(newManager);
    const scoped=(manager:string):Actor=>({...owner,grants:[{domain:'workers',operation:'READ',dataClass:'planning',scope:'reports',orgId:manager,validFrom:'2000-01-01',validTo:null}]});
    await expect(getRecord(scoped(oldManager),'workers',f.worker.id,date)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
    expect((await getRecord(scoped(newManager),'workers',f.worker.id,date)).id).toBe(f.worker.id);
    expect((await getRecord(scoped(oldManager),'workers',f.worker.id,'2026-10-31')).id).toBe(f.worker.id);
    expect((await getRecord(owner,'redeployments',f.placement.id,date)).data.considerForRoles).toBe(false);
    expect((await getRecord(owner,'demands',f.need.id,'2026-10-31')).state).toBe('approved');
    expect((await getRecord(owner,'demands',f.need.id,date)).state).toBe('filled');
    await expect(commit(result.record)).rejects.toMatchObject({code:'APPROVAL_REQUIRED'});
    const audit=await transaction(tenantId,async tx=>(await tx.query('SELECT metadata FROM audit_events WHERE tenant_id=$1',[tenantId])).rows);
    expect(JSON.stringify(audit)).not.toContain('SYNTHETIC protected identity'); expect(JSON.stringify(audit)).not.toContain('90000');
  });
  it('lets the receiving manager flag a placed person again without a new employee request', async () => {
    const f=await fixture(); await commit(f.proposal);
    const manager:Actor={...owner,grants:[{domain:'workers',operation:'READ',dataClass:'planning',scope:'reports',orgId:newManager,validFrom:'2000-01-01',validTo:null},...['READ','UPDATE','FLAG_FOR_ROLES'].map(operation=>({domain:'redeployments',operation,dataClass:'planning',scope:'reports' as const,orgId:newManager,validFrom:'2000-01-01',validTo:null}))]};
    const placed=await getRecord(manager,'redeployments',f.placement.id,'2026-11-02');
    const active=await mutateRecord(manager,'redeployments',{operation:'UPDATE',id:placed.id,version:placed.version,validFrom:'2026-11-02',data:{considerForRoles:true,reason:'Another synthetic team need'}});
    expect(active.id).toBe(f.placement.id); expect(active.state).toBe('active'); expect(active.data.considerForRoles).toBe(true);
    expect((await getRecord(owner,'redeployments',f.placement.id,date)).state).toBe('placed');
    expect((await getRecord(owner,'workers',f.worker.id,'2026-11-02')).data.employmentStatus).toBe('active');
  });
  it('retains someone whose old primary assignment ends at the transfer date', async () => {
    const f=await fixture(true); await commit(f.proposal);
    expect((await getRecord(owner,'assignments',f.assignment.id)).validTo).toBe(date);
    expect((await getRecord(owner,'workers',f.worker.id,date)).orgId).toBe(destinationOrg);
  });
  it('transfers a part-time person using eligible FTE rather than assignment fraction', async () => {
    const f=await fixture(false,0.5); await commit(f.proposal);
    const fills=(await listRecords(owner,'fulfillments',{date,pageSize:200})).rows.filter(row=>row.workerId===f.worker.id);
    expect(fills).toHaveLength(1); expect(fills[0].data.fte).toBe(0.5);
    expect((await getRecord(owner,'demands',f.need.id,date)).state).toBe('filled');
  });
  it('honors a finite team need without scheduling a return to the former team', async () => {
    const f=await fixture(false,1,'2027-02-01'); await commit(f.proposal);
    const fills=(await listRecords(owner,'fulfillments',{date,pageSize:200})).rows.filter(row=>row.workerId===f.worker.id);
    expect(fills[0].validTo).toBe('2027-02-01');
    const allocations=(await listRecords(owner,'assignments',{date:'2027-03-01',pageSize:200})).rows.filter(row=>row.workerId===f.worker.id);
    expect(allocations).toHaveLength(1); expect(allocations[0].orgId).toBe(destinationOrg); expect(allocations[0].validTo).toBeNull();
  });
  it('keeps an existing employment end date and does not overstate ongoing fulfillment', async () => {
    const f=await fixture(false,1,null,'2027-02-01'); await commit(f.proposal);
    const worker=await getRecord(owner,'workers',f.worker.id,date); expect(worker.validTo).toBe('2027-02-01'); expect(worker.data.employmentStatus).toBe('active');
    const allocations=(await listRecords(owner,'assignments',{date:'2027-02-01',pageSize:200})).rows.filter(row=>row.workerId===f.worker.id); expect(allocations).toHaveLength(0);
    expect((await getRecord(owner,'demands',f.need.id,date)).state).toBe('partially-filled');
  });
  it('metadata transfer permission grants no salary or identity read access', async () => {
    const f=await fixture();
    const committer={...owner,grants:owner.grants.map(g=>['identity','salary'].includes(g.dataClass)?{...g,operation:'TRANSFER_SCOPE'}:g)};
    const result=await commit(f.proposal,committer);
    expect(JSON.stringify(result)).not.toContain('90000'); expect(JSON.stringify(result)).not.toContain('protected identity');
    await expect(getRecord(committer,'compensation',f.pay.id)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(getRecord(committer,'identities',f.identity.id)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  });
  it('a planning committer cannot implicitly relocate identity or salary metadata', async () => {
    const f=await fixture(); const restricted={...owner,grants:owner.grants.filter(g=>!['identity','salary'].includes(g.dataClass))};
    await expect(commit(f.proposal,restricted)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect((await getRecord(owner,'workers',f.worker.id)).version).toBe(f.worker.version);
    expect((await getRecord(owner,'assignments',f.assignment.id)).validTo).toBeNull();
    expect((await getRecord(owner,'movements',f.proposal.id)).state).toBe('approved');
  });
  it('rejects stale placement evidence without partial commitment', async () => {
    const f=await fixture(); await mutateRecord(owner,'redeployments',{operation:'UPDATE',id:f.placement.id,version:f.placement.version,validFrom:'2026-10-02',data:{considerForRoles:false}});
    await expect(commit(f.proposal)).rejects.toMatchObject({code:'STALE_MOVEMENT_BASELINE'});
    expect((await getRecord(owner,'workers',f.worker.id)).orgId).toBe(sourceOrg);
  });
  it('does not apply a future pay revision early or partly move the person', async () => {
    const f=await fixture(); await mutateRecord(owner,'compensation',{operation:'UPDATE',id:f.pay.id,version:f.pay.version,validFrom:'2026-12-01',data:{amount:95000}});
    await expect(commit(f.proposal)).rejects.toMatchObject({code:'FUTURE_RECORD_REQUIRES_REVISED_PROPOSAL'});
    expect((await getRecord(owner,'compensation',f.pay.id,date)).data.amount).toBe(90000);
    expect((await getRecord(owner,'workers',f.worker.id)).orgId).toBe(sourceOrg);
    expect((await getRecord(owner,'assignments',f.assignment.id)).validTo).toBeNull();
  });
  it('serializes two approved proposals for one person', async () => {
    const f=await fixture();
    const second=await approve(await proposeTransfer(owner,{placementId:f.placement.id,demandId:f.need.id,destinationManagerId:newManager,effectiveFrom:date,reason:'Competing synthetic proposal'}),'movements');
    const results=await Promise.allSettled([commit(f.proposal),commit(second)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'STALE_MOVEMENT_BASELINE'}});
    const fills=(await listRecords(owner,'fulfillments',{date,pageSize:200})).rows.filter(row=>row.workerId===f.worker.id); expect(fills).toHaveLength(1);
  });
  it('rolls back the whole team request when required skill creation is unauthorized', async () => {
    const restricted={...owner,grants:owner.grants.filter(g=>g.domain!=='request-skills')}; const code='NEED-ROLLBACK-'+randomUUID();
    await expect(createTeamNeed(restricted,{record:{operation:'CREATE',orgId:destinationOrg,validFrom:'2026-10-01',data:{code,roleId,requestType:'transfer',fte:1,priority:'normal',businessCase:'Synthetic requirement',fundingStatus:'funded'}},skillIds:[skillId]})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect((await listRecords(owner,'demands',{date:'2026-10-01',search:code})).total).toBe(0);
  });
});
