import { api, jsonBody } from '@/lib/http';
import { createTeamNeed } from '@/lib/team-needs';
export async function POST(request: Request) {
  return api(request, async actor => createTeamNeed(actor, await jsonBody(request)));
}
