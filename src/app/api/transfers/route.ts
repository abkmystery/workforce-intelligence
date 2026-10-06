import { api, jsonBody } from '@/lib/http';
import { proposeTransfer } from '@/lib/transfers';
export async function POST(request: Request) {
  return api(request, async actor => proposeTransfer(actor, await jsonBody(request)));
}
