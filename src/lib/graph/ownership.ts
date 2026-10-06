import { z } from 'zod';
import { isoDate } from '../validation';
import type { FieldDefinition } from '../types';

export interface DirectoryFieldPolicy { field:string; owner:string; overrideAllowed:boolean }
export interface DirectoryOverride {
 id:string; field:string; value:unknown; state:string; validFrom:string; validTo:string|null;
 expiresOn:string; reason:string;
}
export interface DirectoryIssue { field:string; reason:string; overrideId?:string }
export interface DirectoryResolution {
 data:Record<string,unknown>;
 provenance:Record<string,{overrideId:string|null}>;
 issues:DirectoryIssue[];
}

/** Convert a scalar request value without JavaScript's truthiness/empty-string coercions. */
export function parseDirectoryOverride(field:FieldDefinition,value:unknown):unknown {
 if(typeof value!=='string')throw new Error('Override value must be a string');
 if(field.nullable&&field.type!=='text'&&value==='null')return null;
 if(field.type==='number'){
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)||!Number.isFinite(Number(value)))throw new Error('Invalid numeric override');
  return Number(value);
 }
 if(field.type==='boolean'){if(value==='true')return true;if(value==='false')return false;throw new Error('Invalid boolean override');}
 if(field.type==='date')return isoDate.parse(value);
 if(field.type==='uuid')return z.uuid().parse(value);
 if(field.type==='select'){if(!field.options?.includes(value))throw new Error('Invalid option override');return value;}
 if(value.length>10000||/[\u0000-\u0008]/.test(value))throw new Error('Invalid text override');
 return value;
}

/** Policies are supplied newest-effective first. Only source-backed scalar fields can be restored. */
export function resolveDirectoryFields(current:Record<string,unknown>,source:Record<string,unknown>,
 fields:Record<string,FieldDefinition>,policies:DirectoryFieldPolicy[],overrides:DirectoryOverride[],date:string):DirectoryResolution {
 const data={...current};const provenance:DirectoryResolution['provenance']={};const issues:DirectoryIssue[]=[];
 const policyMap=new Map<string,DirectoryFieldPolicy>();for(const policy of policies)if(!policyMap.has(policy.field))policyMap.set(policy.field,policy);
 const approved=overrides.filter(o=>o.state==='approved');
 const effective=(o:DirectoryOverride)=>o.validFrom<=date&&(!o.validTo||o.validTo>date)&&o.expiresOn>date;
 for(const [field,value]of Object.entries(source)){
  if(field==='objectId'||!fields[field])continue;
  const policy=policyMap.get(field);const owner=policy?.owner??fields[field].owner??'Entra';
  if(owner!=='Entra'){
   if(!Object.is(current[field],value))issues.push({field,reason:'FIELD_OWNER_CONFLICT'});
   for(const override of approved.filter(o=>o.field===field)){
    if(effective(override))issues.push({field,reason:'OVERRIDE_OWNER_CONFLICT',overrideId:override.id});
    else if(override.validFrom<=date&&(override.expiresOn<=date||Boolean(override.validTo&&override.validTo<=date)))issues.push({field,reason:'EXPIRED_OVERRIDE_OWNER_CONFLICT',overrideId:override.id});
   }
   continue;
  }
  data[field]=value;provenance[field]={overrideId:null};
  const active=approved.filter(o=>o.field===field&&effective(o));
  if(active.length>1){data[field]=current[field];delete provenance[field];issues.push({field,reason:'MULTIPLE_ACTIVE_OVERRIDES'});continue;}
  if(active.length===1){
   const override=active[0];
   if(!policy?.overrideAllowed){issues.push({field,reason:'OVERRIDE_NOT_ALLOWED',overrideId:override.id});continue;}
   if(!override.reason.trim()){issues.push({field,reason:'OVERRIDE_REASON_REQUIRED',overrideId:override.id});continue;}
   try{data[field]=parseDirectoryOverride(fields[field],override.value);provenance[field]={overrideId:override.id};}
   catch{issues.push({field,reason:'INVALID_OVERRIDE_VALUE',overrideId:override.id});}
  }else{
   for(const override of approved.filter(o=>o.field===field&&o.validFrom<=date&&(o.expiresOn<=date||Boolean(o.validTo&&o.validTo<=date))))issues.push({field,reason:'DIRECTORY_OVERRIDE_EXPIRED',overrideId:override.id});
  }
 }
 for(const override of approved.filter(effective))if(override.field==='objectId'||!Object.prototype.hasOwnProperty.call(source,override.field))issues.push({field:Object.prototype.hasOwnProperty.call(fields,override.field)?override.field:'unknown',reason:'UNSUPPORTED_DIRECTORY_OVERRIDE_FIELD',overrideId:override.id});
 return {data,provenance,issues};
}
