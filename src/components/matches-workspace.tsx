"use client";

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { RecordRow } from '@/lib/types';
import type { MatchResult } from '@/lib/matching-contract';
import { ReferencePicker } from './reference-picker';
import { api, messageFrom } from './api';

export function MatchesWorkspace() {
  const params = useSearchParams();
  const date = params.get('date') || new Date().toISOString().slice(0, 10);
  const [requestId, setRequestId] = useState('');
  const [result, setResult] = useState<MatchResult | null>(null);
  const [selected, setSelected] = useState<{ placementId: string; code: string } | null>(null);
  const [destinationManagerId, setDestinationManagerId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(date);
  const [reason, setReason] = useState('');
  const [proposal, setProposal] = useState<RecordRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function search(page = 1) {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await api<MatchResult>(`/api/matches?${new URLSearchParams({ requestId, date, page: String(page) })}`)); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  async function propose(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setError(null);
    try {
      const saved = await api<RecordRow>('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placementId: selected.placementId, demandId: requestId, destinationManagerId, effectiveFrom, reason }) });
      setProposal(saved); setSelected(null);
    } catch (error) { setError(error); } finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-header"><h2>Review potential internal placements</h2></div>
    <div className="panel-body">
      <form onSubmit={event => { event.preventDefault(); if (requestId) void search(); }}>
        <ReferencePicker id="match-request" label="Team request" domain="demands" value={requestId} onChange={value => { setRequestId(value); setResult(null); setError(null); setSelected(null); setProposal(null); }} date={date} orgId={params.get('orgId') || undefined} required />
        <button className="btn primary" type="submit" disabled={!requestId || busy}>{busy ? 'Comparing…' : 'Find matches'}</button>
      </form>
      <p className="hint">Only people flagged for consideration by an authorized manager or HR and visible to you are included. The person does not need to request a role. Each criterion shows its evidence or what needs review. Salary comparisons require separate permission. Annual budgets compare full-time base salary, excluding bonus and benefits.</p>
      {error != null && <div className="alert" role="alert">{messageFrom(error)}</div>}
      {busy && <p role="status">Loading placement evidence…</p>}
      {result && <>
        <p>Request <strong>{result.code}</strong> needs people from {result.neededFrom}. Planning records as of {result.asOf}.</p>
        {result.candidates.length === 0 ? <p className="empty-state">No visible people are flagged for consideration. In People needing a role, set Consider for internal roles to Yes, or review the planning date and access.</p> : <div className="table-wrap"><table className="data-table">
          <caption className="sr-only">Potential placements and evidence for each criterion</caption>
          <thead><tr>{['Person', 'Dates', 'Skills', 'Location', 'FTE', 'Salary budget', 'Transfer'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{result.candidates.map(candidate => <tr key={candidate.placementId}>
            <th scope="row">{candidate.code}<p className="hint">{candidate.reason}</p></th>
            <td>{candidate.evidence.dates}<p className="hint">Available {candidate.availableFrom}{candidate.placementDeadline ? ` · Place before ${candidate.placementDeadline}` : ''}</p></td>
            <td>{candidate.evidence.skills}</td><td>{candidate.evidence.location}</td><td>{candidate.evidence.fte}</td><td>{candidate.evidence.salary}</td><td><button className="btn" disabled={busy} onClick={() => { setSelected(candidate); setEffectiveFrom(result.neededFrom); setReason(''); setDestinationManagerId(''); setProposal(null); setError(null); }}>Propose transfer<span className="sr-only"> for {candidate.code}</span></button></td>
          </tr>)}</tbody>
        </table></div>}
        {selected && <form onSubmit={propose} aria-label="Propose permanent transfer">
          <h3>Transfer {selected.code}</h3>
          <p className="hint">The whole primary assignment will move to the requesting team after independent approval and explicit commitment. Review all unknown or mismatched evidence with both teams.</p>
          <div className="form-grid">
            <div className="field"><label htmlFor="transfer-from">Transfer date</label><input id="transfer-from" type="date" required value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></div>
            <ReferencePicker id="transfer-manager" label="Destination manager" domain="workers" value={destinationManagerId} onChange={setDestinationManagerId} date={effectiveFrom} required />
            <div className="field wide"><label htmlFor="transfer-reason">Transfer reason</label><input id="transfer-reason" required minLength={5} value={reason} onChange={event => setReason(event.target.value)} /></div>
          </div>
          <div className="action-row"><button className="btn primary" disabled={busy} type="submit">Save transfer proposal</button><button className="btn" type="button" onClick={() => setSelected(null)}>Cancel proposal</button></div>
        </form>}
        {proposal && <p role="status">Transfer proposal saved. <Link href={`/workspace/mobility?id=${proposal.id}&date=${proposal.validFrom}`}>Review and submit proposal</Link></p>}
        <div className="action-row"><button className="btn" disabled={busy || result.page === 1} onClick={() => void search(result.page - 1)}>Previous</button><span>Page {result.page}</span><button className="btn" disabled={busy || !result.hasMore} onClick={() => void search(result.page + 1)}>Next</button></div>
        <p className="hint">Review the evidence with both teams and the person before proposing an internal move.</p>
        <Link href="/workspace/mobility">Review transfer proposals</Link>
      </>}
    </div>
  </section>;
}
