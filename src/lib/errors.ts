export class AppError extends Error { constructor(public status:number,public code:string,message?:string){super(message ?? code.replaceAll('_',' ').toLowerCase()); this.name='AppError';} }
export function invariant(value:unknown,code:string,status=422,message?:string):asserts value { if(!value) throw new AppError(status,code,message); }
