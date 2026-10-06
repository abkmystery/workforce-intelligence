import { api } from '@/lib/http';
import { findMatches, matchQuery } from '@/lib/matching';

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  return api(request, actor => findMatches(actor, matchQuery.parse({ requestId: q.get('requestId'), date: q.get('date') ?? undefined, page: q.get('page') ?? 1 })));
}
