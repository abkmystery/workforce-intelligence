import {describe,it,expect} from 'vitest';
import {parseDirectoryOverride,resolveDirectoryFields,type DirectoryOverride} from '../src/lib/graph/ownership';
import type {FieldDefinition} from '../src/lib/types';
const fields:Record<string,FieldDefinition>={directoryTitle:{label:'Title',type:'text',owner:'Entra'},enabled:{label:'Enabled',type:'boolean',owner:'Entra'}};
const date='2026-09-25';
const override:DirectoryOverride={id:'override-1',field:'directoryTitle',value:'Approved temporary title',state:'approved',validFrom:'2026-09-01',validTo:null,expiresOn:'2026-10-01',reason:'Synthetic approval reason'};
const policy={field:'directoryTitle',owner:'Entra',overrideAllowed:true};
const current={directoryTitle:'Previous value',enabled:true};const source={directoryTitle:'Upstream latest',enabled:false};
describe('directory field ownership and bounded overrides',()=>{
 it('preserves fields owned by another source while updating Entra fields',()=>{const result=resolveDirectoryFields(current,source,fields,[{...policy,owner:'HR'}],[],date);expect(result.data).toEqual({directoryTitle:'Previous value',enabled:false});expect(result.issues).toContainEqual({field:'directoryTitle',reason:'FIELD_OWNER_CONFLICT'});expect(result.provenance.directoryTitle).toBeUndefined();});
 it('applies only approved, currently effective overrides with explicit permission',()=>{
  const result=resolveDirectoryFields(current,source,fields,[policy],[override],date);expect(result.data.directoryTitle).toBe(override.value);expect(result.provenance.directoryTitle.overrideId).toBe(override.id);
  for(const changed of [{state:'submitted'},{validFrom:'2026-09-26'},{validTo:date},{expiresOn:date}])expect(resolveDirectoryFields(current,source,fields,[policy],[{...override,...changed}],date).data.directoryTitle).toBe('Upstream latest');
  expect(resolveDirectoryFields(current,source,fields,[{...policy,overrideAllowed:false}],[override],date).data.directoryTitle).toBe('Upstream latest');
 });
 it('restores source on the exclusive expiry boundary and flags the event',()=>{const result=resolveDirectoryFields(current,source,fields,[policy],[{...override,expiresOn:date}],date);expect(result.data.directoryTitle).toBe('Upstream latest');expect(result.provenance.directoryTitle.overrideId).toBeNull();expect(result.issues).toContainEqual({field:'directoryTitle',reason:'DIRECTORY_OVERRIDE_EXPIRED',overrideId:override.id});});
 it('preserves another owner on expiry and reports the ownership conflict',()=>{const result=resolveDirectoryFields(current,source,fields,[{...policy,owner:'application'}],[{...override,expiresOn:date}],date);expect(result.data.directoryTitle).toBe('Previous value');expect(result.issues).toContainEqual({field:'directoryTitle',reason:'EXPIRED_OVERRIDE_OWNER_CONFLICT',overrideId:override.id});});
 it('does not arbitrarily select between concurrent approved overrides',()=>{const result=resolveDirectoryFields(current,source,fields,[policy],[override,{...override,id:'override-2',value:'Conflicting title'}],date);expect(result.data.directoryTitle).toBe('Previous value');expect(result.provenance.directoryTitle).toBeUndefined();expect(result.issues).toContainEqual({field:'directoryTitle',reason:'MULTIPLE_ACTIVE_OVERRIDES'});});
 it('rejects unknown/non-restorable fields and invalid approved values',()=>{const unsupported=resolveDirectoryFields(current,source,fields,[policy],[{...override,field:'objectId'}],date);expect(unsupported.issues[0].reason).toBe('UNSUPPORTED_DIRECTORY_OVERRIDE_FIELD');const invalid=resolveDirectoryFields(current,source,fields,[{field:'enabled',owner:'Entra',overrideAllowed:true}],[{...override,field:'enabled',value:'yes'}],date);expect(invalid.data.enabled).toBe(false);expect(invalid.issues[0].reason).toBe('INVALID_OVERRIDE_VALUE');});
 it('converts scalar types strictly without truthy strings or empty numeric coercion',()=>{
  expect(parseDirectoryOverride({label:'Boolean',type:'boolean'},'false')).toBe(false);expect(()=>parseDirectoryOverride({label:'Boolean',type:'boolean'},'0')).toThrow();
  expect(parseDirectoryOverride({label:'Numeric',type:'number'},'12.50')).toBe(12.5);for(const value of ['',' ','NaN','Infinity','0xFF'])expect(()=>parseDirectoryOverride({label:'Numeric',type:'number'},value)).toThrow();
  expect(()=>parseDirectoryOverride({label:'Date',type:'date'},'2026-02-30')).toThrow();expect(parseDirectoryOverride({label:'Nullable',type:'number',nullable:true},'null')).toBeNull();
  expect(()=>parseDirectoryOverride({label:'Option',type:'select',options:['Member','Guest']},'Administrator')).toThrow();expect(()=>parseDirectoryOverride({label:'UUID',type:'uuid'},'not-an-id')).toThrow();
 });
 it('does not copy arbitrary protected field text into reconciliation metadata',()=>{const sensitiveFieldText='Synthetic protected name and pay';const result=resolveDirectoryFields(current,source,fields,[policy],[{...override,field:sensitiveFieldText}],date);expect(result.issues).toContainEqual({field:'unknown',reason:'UNSUPPORTED_DIRECTORY_OVERRIDE_FIELD',overrideId:override.id});expect(JSON.stringify(result.issues)).not.toContain(sensitiveFieldText);});
});
