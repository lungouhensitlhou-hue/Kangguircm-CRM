import { listSequences, listTemplates } from "@rcm/core";
import { SequenceEditor } from "@/components/SequenceEditor";

export const dynamic = "force-dynamic";

export default async function Sequences() {
  const [seqs, templates] = await Promise.all([listSequences(), listTemplates()]);
  const tpls = templates.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name }));
  return (
    <>
      <div className="head"><div><h1>Sequences</h1><div className="muted">Step 1 is the first email; each follow-up waits N days after the previous one is sent, and stops the moment someone replies. The default sequence applies to every lead without its own; if none is set, the follow-up days in Settings are used. Steps without a template are written by the AI.</div></div></div>
      <div className="grid g2">
        <SequenceEditor templates={tpls} />
        <div className="grid" style={{ alignContent: "start" }}>
          {seqs.length === 0 && <div className="card muted">No sequences yet; the Settings follow-up days are in effect.</div>}
          {seqs.map((s) => <SequenceEditor key={s.id + JSON.stringify(s.steps)} seq={{ id: s.id, name: s.name, steps: s.steps, is_default: s.is_default }} templates={tpls} />)}
        </div>
      </div>
    </>
  );
}
